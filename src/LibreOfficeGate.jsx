import React, { useEffect, useRef } from 'react';
import { useApp } from './store.jsx';
import { Logo, Button, Icon, Progress, motion } from './ui.jsx';

/**
 * Mandatory LibreOffice gate.
 *
 * MorphEra relies on LibreOffice for every Office/OpenDocument conversion. The
 * app stays usable for images, media and PDFs once the dependency is present,
 * but until then this overlay blocks the workspace and explains exactly what
 * to install. It is intentionally not dismissable.
 */
export default function LibreOfficeGate() {
  const {
    info, office, officeBusy, officeInstall, refreshOffice, locateOffice,
    installOffice, cancelOfficeInstall,
  } = useApp();
  const autoTried = useRef(false);

  // If the fast startup check found a binary but did not verify it yet, verify
  // once so the gate can disappear without the user pressing anything. The ref
  // stops a failed IPC call from retrying forever in a render loop.
  const needsVerify = !!(office && office.installed && office.verified == null && !officeBusy && !autoTried.current);
  useEffect(() => {
    if (!needsVerify) return;
    autoTried.current = true;
    refreshOffice();
  }, [needsVerify, refreshOffice]);

  // A missing installation, or a healthy one that was later removed, should
  // get a fresh automatic check when it comes back.
  useEffect(() => {
    if (!office || !office.installed || office.healthy === true) autoTried.current = false;
  }, [office && office.installed, office && office.healthy]); // eslint-disable-line

  if (!info) return null;
  if (office && office.healthy === true) return null;

  const installing = !!(officeInstall && officeInstall.busy);
  const checking = !installing && (officeBusy || needsVerify || (!office && !info));
  const missing = !office || !office.installed;
  const failed = !installing && !checking && !missing && office.healthy !== true;
  const installFailed = !!(officeInstall && officeInstall.stage === 'error');
  const percent = Math.max(0, Math.min(100, Number(officeInstall && officeInstall.percent) || 0));
  const steps = (office && office.instructions) || [
    'Click “Download LibreOffice” to install the official version automatically.',
    'Approve the Windows administrator prompt if it appears.',
    'MorphEra verifies the installation and unlocks the workspace.',
  ];

  return (
    <motion.div className="office-gate" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} role="dialog" aria-modal="true" aria-labelledby="office-gate-title">
      <motion.div className="office-gate-card glass" initial={{ y: 18, scale: 0.98 }} animate={{ y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 26 }}>
        <div className="office-gate-head">
          <Logo size={46} />
          <div>
            <div className="office-gate-kicker">One quick setup step</div>
            <h1 id="office-gate-title">LibreOffice is required</h1>
          </div>
        </div>

        <p className="office-gate-lead">
          MorphEra uses <b>LibreOffice</b> — a free, open-source office suite — to open and convert
          Word, Excel, PowerPoint, OpenDocument and RTF files. Everything still runs on your computer;
          nothing is uploaded.
        </p>

        <div className={`office-gate-status ${installing ? 'checking' : checking ? 'checking' : missing ? 'missing' : failed || installFailed ? 'failed' : 'ok'}`}>
          <span className="office-gate-dot" aria-hidden="true" />
          <div className="grow">
            {installing ? (
              <>
                <b>{officeInstall.stage === 'install' ? 'Installing LibreOffice…' : 'Setting up LibreOffice…'}</b>
                <span>{officeInstall.message || 'This can take a few minutes. Keep MorphEra open.'}</span>
              </>
            ) : checking ? (
              <>
                <b>Checking your installation…</b>
                <span>Looking for LibreOffice and making sure it starts.</span>
              </>
            ) : missing ? (
              <>
                <b>LibreOffice was not found</b>
                <span>Download it below, then this screen unlocks automatically.</span>
              </>
            ) : failed ? (
              <>
                <b>LibreOffice was found, but it could not start</b>
                <span>{office.error || 'Close any open LibreOffice windows and try again, or locate the program manually.'}</span>
              </>
            ) : (
              <>
                <b>LibreOffice is ready{office.version && office.version !== 'unknown' ? ` · ${office.version}` : ''}</b>
                <span>{office.path}</span>
              </>
            )}
          </div>
        </div>

        {(installing || installFailed || (officeInstall && officeInstall.percent > 0 && !officeInstall.busy && !installFailed)) && (
          <div className={`office-install ${installFailed ? 'failed' : ''}`} role="status" aria-live="polite">
            <div className="office-install-meta">
              <span>{officeInstall.message || 'Preparing LibreOffice…'}</span>
              <span>{Math.round(percent)}%</span>
            </div>
            <Progress value={percent / 100} />
            <div className="office-install-foot">
              <span>
                {officeInstall.stage === 'download' && officeInstall.total
                  ? 'Downloading from the official Document Foundation mirror.'
                  : officeInstall.stage === 'install'
                    ? 'Windows may ask for administrator permission. LibreOffice installs without opening any setup windows.'
                    : 'MorphEra verifies the installer before running it.'}
              </span>
              {officeInstall.cancellable && (
                <Button variant="ghost" onClick={cancelOfficeInstall}>Cancel</Button>
              )}
            </div>
          </div>
        )}

        <div className="office-gate-grid">
          <div className="office-gate-steps">
            <div className="opt-title">How to install</div>
            <ol>
              {steps.map((s) => <li key={s}>{s}</li>)}
            </ol>
            <div className="hint">If you installed LibreOffice somewhere unusual, use “Locate LibreOffice” and choose the <span className="mono">soffice</span> program.</div>
          </div>
          <div className="office-gate-actions">
            <Button variant="primary" icon="download" onClick={installOffice} disabled={installing || officeBusy}>
              {installing ? 'Installing…' : 'Download LibreOffice'}
            </Button>
            <Button variant="soft" icon="refresh" onClick={refreshOffice} disabled={officeBusy || installing}>{officeBusy ? 'Checking…' : 'Check again'}</Button>
            <Button variant="ghost" icon="folder" onClick={locateOffice} disabled={officeBusy || installing}>Locate LibreOffice</Button>
          </div>
        </div>

        <div className="office-gate-foot">
          <Icon name="shield" size={15} />
          <span>LibreOffice is required for document conversions. It is free and works offline.</span>
        </div>
      </motion.div>
    </motion.div>
  );
}
