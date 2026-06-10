import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ToastProvider } from './components/ui';
import { DialogProvider, useDialog } from './components/dialog';
import { I18nProvider } from './i18n';
import { AuthProvider } from './auth';
import { BrandingProvider } from './branding';
import { QuotaProvider } from './quota';
import { PageVisibilityProvider } from './pageVisibility';
import { ThemeProvider } from './components/theme-provider';
import './styles.css';

// Bridge: only `window.alert` rebinds to styled dialog (fire-and-forget OK).
// `confirm`/`prompt` are sync-Promise-incompatible — call sites use `useDialog()` directly.
function NativeDialogBridge() {
  const dlg = useDialog();
  if (!(window as any).__nativeBridgeInstalled) {
    (window as any).__nativeBridgeInstalled = true;
    window.alert = ((m: string) => { void dlg.alert(String(m ?? '')); }) as any;
  }
  return null;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
      <ToastProvider>
        <DialogProvider>
          <NativeDialogBridge />
          <AuthProvider>
            <BrandingProvider>
              <I18nProvider>
                <QuotaProvider>
                  <PageVisibilityProvider>
                    <App />
                  </PageVisibilityProvider>
                </QuotaProvider>
              </I18nProvider>
            </BrandingProvider>
          </AuthProvider>
        </DialogProvider>
      </ToastProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);
