import path from 'node:path';
import fs from 'node:fs/promises';
import matter from 'gray-matter';
import { query, getSetting } from '../db/index.js';
import { getUserByEmail, getUserById } from '../auth/index.js';
import { getVaultRoot, writeNote } from '../brain/vault.js';
import { runClaude } from '../claude/runner.js';
import { buildSystemContext } from '../claude/prompts.js';
import { sendTelegram } from '../telegram/bot.js';

function canon(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

// ---------- Connections ----------

export async function requestConnection(fromUserId: number, toEmail: string) {
  const target = await getUserByEmail(toEmail);
  if (!target) throw new Error('user not found');
  if (target.id === fromUserId) throw new Error('cannot connect to yourself');
  const [a, b] = canon(fromUserId, target.id);
  const existing = await query<any>('SELECT id::int, status, initiator_user_id FROM user_connections WHERE a_user_id=$1 AND b_user_id=$2', [a, b]);
  if (existing[0]) {
    if (existing[0].status === 'accepted') return { ok: true, alreadyConnected: true };
    if (existing[0].status === 'pending') return { ok: true, alreadyPending: true };
  }
  await query(
    `INSERT INTO user_connections(a_user_id, b_user_id, status, initiator_user_id) VALUES($1, $2, 'pending', $3)
     ON CONFLICT (a_user_id, b_user_id) DO UPDATE SET status='pending', initiator_user_id=$3, created_at=now(), decided_at=NULL`,
    [a, b, fromUserId]
  );
  try {
    const me = await getUserById(fromUserId);
    await sendTelegram(target.id, `🔗 *${me?.name || me?.email}* vuole connettersi al tuo brain.\n\nApri *Network → Richieste* per accettare o rifiutare.`);
    console.log(`[network] connection request notify sent to u${target.id}`);
  } catch (e) {
    console.error(`[network] notify u${target.id} failed:`, (e as any)?.message ?? e);
  }
  return { ok: true };
}

export async function respondConnection(myUserId: number, connectionId: number, accept: boolean) {
  const rows = await query<any>(
    `SELECT id::int, a_user_id::int, b_user_id::int, initiator_user_id::int, status FROM user_connections WHERE id=$1`,
    [connectionId]
  );
  const c = rows[0];
  if (!c) throw new Error('connection not found');
  if (c.a_user_id !== myUserId && c.b_user_id !== myUserId) throw new Error('not your connection');
  if (c.initiator_user_id === myUserId) throw new Error('cannot accept your own request');
  await query(
    `UPDATE user_connections SET status=$2, decided_at=now() WHERE id=$1`,
    [connectionId, accept ? 'accepted' : 'blocked']
  );
  try {
    const me = await getUserById(myUserId);
    await sendTelegram(c.initiator_user_id, accept
      ? `✅ *${me?.name || me?.email}* ha accettato la tua richiesta di connessione brain.`
      : `🚫 *${me?.name || me?.email}* ha rifiutato la richiesta di connessione.`);
  } catch (e) {
    console.error(`[network] respond-notify u${c.initiator_user_id} failed:`, (e as any)?.message ?? e);
  }
  return { ok: true };
}

export async function listPeers(myUserId: number) {
  const rows = await query<any>(
    `SELECT c.id::int, c.status, c.initiator_user_id::int,
            CASE WHEN c.a_user_id=$1 THEN c.b_user_id ELSE c.a_user_id END AS peer_id
       FROM user_connections c
      WHERE c.a_user_id=$1 OR c.b_user_id=$1`,
    [myUserId]
  );
  const out = [];
  for (const r of rows) {
    const u = await getUserById(r.peer_id);
    out.push({
      connection_id: r.id,
      status: r.status,
      direction: r.initiator_user_id === myUserId ? 'outgoing' : 'incoming',
      peer: u ? { id: u.id, email: u.email, name: u.name } : null,
    });
  }
  return out;
}

async function isAccepted(a: number, b: number): Promise<boolean> {
  const [x, y] = canon(a, b);
  const rows = await query<{ status: string }>('SELECT status FROM user_connections WHERE a_user_id=$1 AND b_user_id=$2', [x, y]);
  return rows[0]?.status === 'accepted';
}

// ---------- Share requests ----------

export async function resolvePeer(myUserId: number, identifier: string | number): Promise<{ id: number; email: string; name: string | null } | null> {
  if (typeof identifier === 'number') return getUserById(identifier);
  const raw = identifier.trim();
  if (!raw) return null;
  // 1) Exact email
  if (raw.includes('@')) {
    const u = await getUserByEmail(raw);
    if (u) return { id: u.id, email: u.email, name: u.name };
  }
  // 2) Search among ACCEPTED peers by name (user.name OR profile.name) case-insensitive
  const needle = `%${raw.toLowerCase()}%`;
  const rows = await query<any>(
    `SELECT u.id::int, u.email, u.name,
            (SELECT value FROM settings WHERE user_id=u.id AND key='profile') AS profile
       FROM users u
       JOIN user_connections c
         ON ((c.a_user_id=u.id AND c.b_user_id=$1) OR (c.b_user_id=u.id AND c.a_user_id=$1))
      WHERE c.status='accepted'
        AND (LOWER(COALESCE(u.name,'')) LIKE $2
             OR LOWER(COALESCE(((SELECT value FROM settings WHERE user_id=u.id AND key='profile')->>'name'), '')) LIKE $2
             OR LOWER(u.email) LIKE $2)
      ORDER BY
        CASE WHEN LOWER(COALESCE(u.name,'')) = LOWER($3) THEN 0
             WHEN LOWER(u.email) = LOWER($3) THEN 1
             ELSE 2 END
      LIMIT 1`,
    [myUserId, needle, raw]
  );
  const r = rows[0];
  return r ? { id: r.id, email: r.email, name: r.name } : null;
}

export async function createShareRequest(requesterUserId: number, targetIdentifier: string | number, queryText: string) {
  const target = await resolvePeer(requesterUserId, targetIdentifier);
  if (!target) throw new Error(`peer non trovato: "${targetIdentifier}"`);
  if (target.id === requesterUserId) throw new Error('cannot query yourself');
  if (!await isAccepted(requesterUserId, target.id)) throw new Error('not connected with this user');

  const ins = await query<{ id: number }>(
    `INSERT INTO brain_share_requests(requester_user_id, target_user_id, query_text, status)
     VALUES($1, $2, $3, 'pending') RETURNING id::int`,
    [requesterUserId, target.id, queryText]
  );
  const requestId = ins[0].id;

  // Notify target user — they can manually trigger agent review from the UI
  try {
    const requester = await getUserById(requesterUserId);
    await sendTelegram(target.id,
      `🔗 *${requester?.name || requester?.email}* chiede al tuo brain:\n_"${queryText.slice(0, 200)}"_\n\nApri *Network → Richieste* e premi *Esamina con agente* per vedere cosa il tuo agente proporrebbe di condividere.`
    );
  } catch (e) { console.error(`[network] share notify u${target.id} failed:`, (e as any)?.message ?? e); }

  return { ok: true, request_id: requestId };
}

export async function triggerReview(requestId: number, byUserId: number) {
  const rows = await query<any>(
    `SELECT id::int, target_user_id::int, status FROM brain_share_requests WHERE id=$1`,
    [requestId]
  );
  const r = rows[0];
  if (!r) throw new Error('request not found');
  if (r.target_user_id !== byUserId) throw new Error('not your request');
  if (r.status !== 'pending') throw new Error(`cannot review status=${r.status}`);
  await reviewShareRequest(requestId);
  return { ok: true };
}

async function reviewShareRequest(requestId: number) {
  const rows = await query<any>(
    `SELECT id::int, requester_user_id::int, target_user_id::int, query_text,
            agent_review, approved_items, status, reason, created_at, decided_at
     FROM brain_share_requests WHERE id=$1`,
    [requestId]
  );
  const r = rows[0];
  if (!r) return;
  const requester = await getUserById(r.requester_user_id);
  const targetVault = await getVaultRoot(r.target_user_id);
  if (!targetVault) {
    await query(`UPDATE brain_share_requests SET status='denied', reason=$2, decided_at=now() WHERE id=$1`, [requestId, 'target has no vault']);
    return;
  }

  const lang = ((await getSetting<string>(r.target_user_id, 'language')) ?? 'it');
  const prompt = `Sei l'agente di **${(await getUserById(r.target_user_id))?.email}**. Un altro utente del network — **${requester?.email}** — ti ha inviato questa richiesta di accesso al tuo second brain:

> ${r.query_text}

Compito: cerca nel vault (Grep/Glob/Read in cwd) note PUBBLICHE (visibility=public, o senza visibility) che potrebbero rispondere. NON includere mai note con \`visibility: protected\`.

Per OGNI candidate valuta sensitivity (delicatezza dell'info se condivisa):
- "low": info generica già pubblica, sicura
- "medium": info personale/aziendale soft (preferenze, opinioni, processi interni)
- "high": dati delicati (email contatti, importi, deal in corso, identità persone)

Output STRETTO JSON (niente preamble, niente \`\`\`):
{
  "summary": "1 frase ${lang === 'it' ? 'italiana' : 'inglese'} che descrive cosa è rilevante",
  "candidates": [
    {
      "path": "<relative path>",
      "title": "...",
      "snippet": "max 200 chars",
      "why": "max 80 chars perché è rilevante",
      "sensitivity": "low|medium|high",
      "sensitivity_reason": "max 80 chars perché questa sensitivity"
    }
  ]
}

Se nulla è rilevante, candidates=[].`;

  const res = await runClaude(r.target_user_id, prompt, { cwd: targetVault, timeoutMs: 120_000, kind: 'network_review', meta: { request_id: requestId } });
  let review: any = { summary: '', candidates: [] };
  try {
    const text = res.text.trim().replace(/^```json\s*|\s*```$/g, '');
    review = JSON.parse(text);
  } catch {
    review = { summary: res.text.slice(0, 200), candidates: [] };
  }
  await query(`UPDATE brain_share_requests SET status='reviewed', agent_review=$2::jsonb WHERE id=$1`, [requestId, JSON.stringify(review)]);

  // Notify target user
  try {
    const items = (review.candidates ?? []).length;
    const lines: string[] = [];
    lines.push(`🔗 *Richiesta brain da ${requester?.name || requester?.email}*`);
    lines.push(`_${r.query_text}_`);
    lines.push('');
    lines.push(`Il tuo agente ha trovato *${items}* nota/e candidata/e:`);
    lines.push(review.summary || '');
    if (items > 0) {
      const sample = (review.candidates ?? []).slice(0, 5).map((c: any) => `• ${c.title || c.path}`).join('\n');
      lines.push(sample);
    }
    lines.push('');
    lines.push('Vai su *Network → Pending* per approvare o rifiutare.');
    await sendTelegram(r.target_user_id, lines.join('\n'));
    console.log(`[network] share request notify sent to u${r.target_user_id}`);
  } catch (e) { console.error(`[network] share notify u${r.target_user_id} failed:`, (e as any)?.message ?? e); }
}

export async function listIncomingShareRequests(myUserId: number) {
  const rows = await query<any>(
    `SELECT id::int, requester_user_id::int, query_text, agent_review, status, created_at, decided_at, reason
       FROM brain_share_requests WHERE target_user_id=$1 ORDER BY id DESC LIMIT 50`,
    [myUserId]
  );
  const out = [];
  for (const r of rows) out.push({ ...r, requester: await getUserById(r.requester_user_id) });
  return out;
}

export async function listOutgoingShareRequests(myUserId: number) {
  const rows = await query<any>(
    `SELECT id::int, target_user_id::int, query_text, agent_review, approved_items, status, created_at, decided_at, reason
       FROM brain_share_requests WHERE requester_user_id=$1 ORDER BY id DESC LIMIT 50`,
    [myUserId]
  );
  const out = [];
  for (const r of rows) out.push({ ...r, target: await getUserById(r.target_user_id) });
  return out;
}

export async function approveShareRequest(myUserId: number, requestId: number, pickedPaths: string[]) {
  const rows = await query<any>(
    `SELECT id::int, requester_user_id::int, target_user_id::int, query_text,
            agent_review, approved_items, status, reason, created_at, decided_at
     FROM brain_share_requests WHERE id=$1`,
    [requestId]
  );
  const r = rows[0];
  if (!r) throw new Error('request not found');
  if (r.target_user_id !== myUserId) throw new Error('not your request');
  if (r.status !== 'reviewed' && r.status !== 'pending') throw new Error(`cannot approve status=${r.status}`);

  const candidates: any[] = r.agent_review?.candidates ?? [];
  const chosen = candidates.filter((c) => pickedPaths.includes(c.path));
  await query(`UPDATE brain_share_requests SET status='approved', approved_items=$2::jsonb, decided_at=now() WHERE id=$1`,
    [requestId, JSON.stringify(chosen)]);

  // Deliver: copy notes from target vault → requester vault under shared/<peer>/
  const me = await getUserById(myUserId);
  const targetVault = await getVaultRoot(myUserId);
  const requesterVault = await getVaultRoot(r.requester_user_id);
  if (!targetVault || !requesterVault) throw new Error('vault missing');
  const peerHandle = (me?.email ?? `u${myUserId}`).replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  // Resolve the canonical vault root once for the path-traversal containment checks below.
  const targetRoot = await fs.realpath(targetVault);

  for (const item of chosen) {
    try {
      // SECURITY (sess.2939): item.path is agent/peer-influenced (prompt-injection
      // vector). Reject absolute paths and any `..` segment, then require the resolved
      // path to stay inside the target vault before reading. realpath also defeats
      // symlink-escape from a note that points outside the vault.
      const rel = typeof item.path === 'string' ? item.path : '';
      if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
        console.warn(`[network] rejected unsafe share path: ${JSON.stringify(item.path)}`);
        continue;
      }
      const full = path.resolve(targetVault, rel);
      const realFull = await fs.realpath(full);
      if (realFull !== targetRoot && !realFull.startsWith(targetRoot + path.sep)) {
        console.warn(`[network] rejected out-of-vault share path: ${rel}`);
        continue;
      }
      const raw = await fs.readFile(realFull, 'utf8');
      const parsed = matter(raw);
      // skip if accidentally protected
      if (parsed.data.visibility === 'protected') continue;
      // rel is validated (relative, no `..`), so newRel stays under shared/<peer>/.
      const newRel = `shared/${peerHandle}/${rel}`;
      const fm = {
        ...parsed.data,
        origin: {
          user_id: myUserId,
          user_email: me?.email ?? null,
          original_path: item.path,
          shared_at: new Date().toISOString(),
          request_id: requestId,
        },
        tags: Array.from(new Set([...(parsed.data.tags ?? []), `shared`, `from/${peerHandle}`])),
        visibility: 'public',
      };
      await writeNote(r.requester_user_id, newRel, fm, parsed.content);
      // Stamp origin in brain_index too
      await query(`UPDATE brain_index SET origin_user_id=$1 WHERE user_id=$2 AND path=$3`, [myUserId, r.requester_user_id, newRel]);
    } catch (e) { console.error('[network] copy note failed', e); }
  }

  await query(`UPDATE brain_share_requests SET status='delivered' WHERE id=$1`, [requestId]);
  console.log(`[network] request #${requestId} delivered: ${chosen.length} note(s) → u${r.requester_user_id}`);

  // Notify requester immediately + fire async fulfillment by their agent
  try {
    await sendTelegram(r.requester_user_id, `✅ *${me?.name || me?.email}* ha condiviso ${chosen.length} nota/e. Il tuo agente le sta elaborando per rispondere alla tua richiesta…`);
  } catch (e) { console.error(`[network] delivery notify failed`, e); }

  console.log(`[network] launching fulfillment for u${r.requester_user_id} req#${requestId}`);
  fulfillRequestForRequester(requestId)
    .then(() => console.log(`[network] fulfillment u${r.requester_user_id} req#${requestId} done`))
    .catch((e) => console.error(`[network] fulfillment u${r.requester_user_id} req#${requestId} FAILED`, e));

  return { ok: true, delivered: chosen.length };
}

// Requester-side agent processes the received notes and answers the original query on Telegram.
// Runs async; may take a while.
async function fulfillRequestForRequester(requestId: number) {
  const rows = await query<any>(
    `SELECT id::int, requester_user_id::int, target_user_id::int, query_text, approved_items
     FROM brain_share_requests WHERE id=$1`, [requestId]
  );
  const r = rows[0];
  if (!r) return;
  const approved: any[] = Array.isArray(r.approved_items) ? r.approved_items : [];
  if (!approved.length) return;

  const target = await getUserById(r.target_user_id);
  const me = await getUserById(r.requester_user_id);
  const requesterVault = await getVaultRoot(r.requester_user_id);
  if (!requesterVault) return;

  const peerHandle = (target?.email ?? `u${r.target_user_id}`).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const sys = await buildSystemContext(r.requester_user_id);
  const fileList = approved.map((c: any) => `- shared/${peerHandle}/${c.path}  (${c.title || c.path})`).join('\n');

  const prompt = `${sys}

=== NETWORK FULFILLMENT ===

L'utente ha precedentemente chiesto al cervello di *${target?.name || target?.email}*:

> "${r.query_text}"

Il peer ha appena approvato e condiviso le seguenti note, che ora si trovano nel tuo vault:
${fileList}

ISTRUZIONI:
1. Leggi (Read) queste note nel cwd.
2. Salva un riepilogo strutturato in \`shared/${peerHandle}/_summary-req${requestId}.md\` con frontmatter \`kind: shared-summary\`, \`source: ${target?.email}\`, \`request_id: ${requestId}\`, \`related: [<wikilinks alle note appena ricevute>]\`, e collega anche eventuali note tue rilevanti.
3. Aggiorna la roadmap se queste informazioni sbloccano un item Discovery / Strategy.
4. Rispondi all'utente su Telegram con un messaggio sintetico (max 6 messaggi short, split con <<MSG>>) che:
   - cita esplicitamente la fonte (\`${target?.name || target?.email}\`)
   - estrae l'insight chiave rispetto alla domanda originale
   - chiude con la prossima domanda/azione anchored alla roadmap (regola Conductor).
   Se le note non rispondono o sono insufficienti, dillo onestamente + suggerisci una follow-up query più precisa.

Output: solo il messaggio Telegram (no preamble). Se proprio non c'è nulla di utile, output \`SKIP\`.`;

  const res = await runClaude(r.requester_user_id, prompt, {
    cwd: requesterVault,
    timeoutMs: 240_000,
    kind: 'network_fulfillment',
    meta: { request_id: requestId, peer: target?.email, notes: approved.length },
  });
  if (!res.ok) {
    try { await sendTelegram(r.requester_user_id, `⚠️ Errore elaborando le note di ${target?.name || target?.email}: ${res.stderr.slice(0, 200)}`); } catch {}
    return;
  }
  const out = res.text.trim();
  if (!out || /^SKIP$/i.test(out)) {
    try { await sendTelegram(r.requester_user_id, `_Note ricevute da ${target?.name || target?.email}, ma il tuo agente non ha trovato risposta diretta. Sono salvate in \`shared/${peerHandle}/\` per consultazione futura._`); } catch {}
    return;
  }
  try {
    await sendTelegram(r.requester_user_id, out);
    await query(
      `INSERT INTO messages(user_id, direction, channel, content, meta) VALUES($1,'out','telegram',$2,$3::jsonb)`,
      [r.requester_user_id, out, JSON.stringify({ network_fulfillment: true, request_id: requestId, peer: target?.email })]
    );
  } catch (e) { console.error('[network] fulfillment send failed', e); }
}

export async function denyShareRequest(myUserId: number, requestId: number, reason?: string) {
  const rows = await query<any>(
    `SELECT id::int, requester_user_id::int, target_user_id::int, query_text,
            agent_review, approved_items, status, reason, created_at, decided_at
     FROM brain_share_requests WHERE id=$1`,
    [requestId]
  );
  const r = rows[0];
  if (!r) throw new Error('request not found');
  if (r.target_user_id !== myUserId) throw new Error('not your request');
  await query(`UPDATE brain_share_requests SET status='denied', reason=$2, decided_at=now() WHERE id=$1`,
    [requestId, reason ?? null]);
  try {
    const me = await getUserById(myUserId);
    await sendTelegram(r.requester_user_id, `🚫 *${me?.name || me?.email}* ha rifiutato la tua richiesta brain${reason ? `: ${reason}` : '.'}`);
  } catch {}
  return { ok: true };
}
