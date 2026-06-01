import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faWhatsapp, faTelegram, faGoogle, faSlack, faDiscord, faGithub, faGitlab, faBitbucket,
  faDropbox, faSpotify, faTwitter, faXTwitter, faFacebook, faInstagram, faLinkedin, faYoutube,
  faTiktok, faReddit, faStripe, faPaypal, faApple, faMicrosoft, faAws, faAirbnb, faShopify,
  faJira, faTrello, faAtlassian, faFigma, faMedium, faNotion, faSalesforce, faHubspot,
  faMailchimp, faZoom,
} from '@fortawesome/free-brands-svg-icons';
import {
  faEnvelope, faBolt, faPlug, faCloud, faCalendarDays, faNoteSticky, faFileLines, faImage,
  faVideo, faMicrophone, faChartLine, faBrain, faComments, faServer, faDatabase, faRobot,
} from '@fortawesome/free-solid-svg-icons';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';

// Brand match rules: lowercased substring → icon + color (Tailwind class).
// Order matters: first match wins. Add new brands at top to override generic matches.
const RULES: Array<{ match: RegExp; icon: IconDefinition; color: string; label: string }> = [
  { match: /whatsapp|wa[\b_-]/i, icon: faWhatsapp, color: 'text-[#25D366]', label: 'WhatsApp' },
  { match: /telegram/i,          icon: faTelegram, color: 'text-[#26A5E4]', label: 'Telegram' },
  { match: /gmail/i,             icon: faGoogle,   color: 'text-[#EA4335]', label: 'Gmail' },
  { match: /google.?cal|gcal/i,  icon: faCalendarDays, color: 'text-[#4285F4]', label: 'Google Calendar' },
  { match: /google.?drive|gdrive/i, icon: faGoogle, color: 'text-[#1FA463]', label: 'Google Drive' },
  { match: /google/i,            icon: faGoogle,   color: 'text-[#4285F4]', label: 'Google' },
  { match: /slack/i,             icon: faSlack,    color: 'text-[#4A154B]', label: 'Slack' },
  { match: /discord/i,           icon: faDiscord,  color: 'text-[#5865F2]', label: 'Discord' },
  { match: /github/i,            icon: faGithub,   color: 'text-text',      label: 'GitHub' },
  { match: /gitlab/i,            icon: faGitlab,   color: 'text-[#FC6D26]', label: 'GitLab' },
  { match: /bitbucket/i,         icon: faBitbucket, color: 'text-[#2684FF]', label: 'Bitbucket' },
  { match: /dropbox/i,           icon: faDropbox,  color: 'text-[#0061FF]', label: 'Dropbox' },
  { match: /spotify/i,           icon: faSpotify,  color: 'text-[#1DB954]', label: 'Spotify' },
  { match: /x[-_ ]?twitter|twitter/i, icon: faXTwitter, color: 'text-text', label: 'X' },
  { match: /facebook|meta/i,     icon: faFacebook, color: 'text-[#1877F2]', label: 'Facebook' },
  { match: /instagram/i,         icon: faInstagram, color: 'text-[#E4405F]', label: 'Instagram' },
  { match: /linkedin/i,          icon: faLinkedin, color: 'text-[#0A66C2]', label: 'LinkedIn' },
  { match: /youtube/i,           icon: faYoutube,  color: 'text-[#FF0000]', label: 'YouTube' },
  { match: /tiktok/i,            icon: faTiktok,   color: 'text-text',      label: 'TikTok' },
  { match: /reddit/i,            icon: faReddit,   color: 'text-[#FF4500]', label: 'Reddit' },
  { match: /stripe/i,            icon: faStripe,   color: 'text-[#635BFF]', label: 'Stripe' },
  { match: /paypal/i,            icon: faPaypal,   color: 'text-[#003087]', label: 'PayPal' },
  { match: /apple|icloud/i,      icon: faApple,    color: 'text-text',      label: 'Apple' },
  { match: /microsoft|outlook|365|m365|teams/i, icon: faMicrosoft, color: 'text-[#0078D4]', label: 'Microsoft' },
  { match: /aws|amazon/i,        icon: faAws,      color: 'text-[#FF9900]', label: 'AWS' },
  { match: /airbnb/i,            icon: faAirbnb,   color: 'text-[#FF5A5F]', label: 'Airbnb' },
  { match: /shopify/i,           icon: faShopify,  color: 'text-[#7AB55C]', label: 'Shopify' },
  { match: /jira/i,              icon: faJira,     color: 'text-[#0052CC]', label: 'Jira' },
  { match: /trello/i,            icon: faTrello,   color: 'text-[#0079BF]', label: 'Trello' },
  { match: /atlassian|confluence/i, icon: faAtlassian, color: 'text-[#0052CC]', label: 'Atlassian' },
  { match: /figma/i,             icon: faFigma,    color: 'text-[#F24E1E]', label: 'Figma' },
  { match: /medium/i,            icon: faMedium,   color: 'text-text',      label: 'Medium' },
  { match: /notion/i,            icon: faNotion,   color: 'text-text',      label: 'Notion' },
  { match: /salesforce/i,        icon: faSalesforce, color: 'text-[#00A1E0]', label: 'Salesforce' },
  { match: /hubspot/i,           icon: faHubspot,  color: 'text-[#FF7A59]', label: 'HubSpot' },
  { match: /mailchimp/i,         icon: faMailchimp, color: 'text-[#FFE01B]', label: 'Mailchimp' },
  { match: /zoom/i,              icon: faZoom,     color: 'text-[#2D8CFF]', label: 'Zoom' },
  // Canva not in free-brands; fallback to image icon.
  { match: /canva/i,             icon: faImage,    color: 'text-[#00C4CC]', label: 'Canva' },
  // Generic fallbacks by protocol/category.
  { match: /imap|smtp|email|mail/i, icon: faEnvelope, color: 'text-accent', label: 'Email' },
  { match: /calendar/i,          icon: faCalendarDays, color: 'text-accent', label: 'Calendar' },
  { match: /note|markdown|brain/i, icon: faBrain, color: 'text-accent', label: 'Brain' },
  { match: /chat|message|messag/i, icon: faComments, color: 'text-accent', label: 'Chat' },
  { match: /video/i,             icon: faVideo,    color: 'text-accent', label: 'Video' },
  { match: /audio|voice|microphone/i, icon: faMicrophone, color: 'text-accent', label: 'Audio' },
  { match: /db|database|postgres|mysql|sqlite/i, icon: faDatabase, color: 'text-accent', label: 'DB' },
  { match: /server|api|http|rest/i, icon: faServer, color: 'text-accent', label: 'Server' },
  { match: /image|photo|pic/i,   icon: faImage,    color: 'text-accent', label: 'Image' },
  { match: /doc|file|sheet/i,    icon: faFileLines, color: 'text-accent', label: 'Docs' },
  { match: /analytic|chart|metric/i, icon: faChartLine, color: 'text-accent', label: 'Analytics' },
  { match: /cloud/i,             icon: faCloud,    color: 'text-accent', label: 'Cloud' },
  { match: /agent|bot|llm|ai/i,  icon: faRobot,    color: 'text-accent', label: 'Agent' },
  { match: /webhook|trigger|event/i, icon: faBolt, color: 'text-accent', label: 'Event' },
];

const FALLBACK = { icon: faPlug, color: 'text-muted', label: 'Connector' };

export function resolveBrand(name: string, title?: string): { icon: IconDefinition; color: string; label: string } {
  const hay = `${name ?? ''} ${title ?? ''}`;
  for (const r of RULES) if (r.match.test(hay)) return r;
  return FALLBACK;
}

export default function ConnectorIcon({ name, title, size = 22, className = '' }: { name: string; title?: string; size?: number; className?: string }) {
  const b = resolveBrand(name, title);
  return (
    <span className={`inline-flex items-center justify-center ${b.color} ${className}`} title={b.label} style={{ width: size, height: size }}>
      <FontAwesomeIcon icon={b.icon} style={{ fontSize: size }} />
    </span>
  );
}
