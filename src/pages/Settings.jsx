import React from 'react';
import { api, fmtBytes, errorText } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon, Button, PageHeader, Card, Segmented, Toggle, Field, Logo, Progress } from '../ui.jsx';

export default function Settings() {
  const {
    info, setSettings, toast, office, officeBusy, officeInstall, refreshOffice, locateOffice,
    installOffice, cancelOfficeInstall,
  } = useApp();
  if (!info) return null;
  const s = info.settings;

  // Prefer the live office state (re-verified after startup); fall back to the
  // fast snapshot that arrived with app info.
  const lo = office || info.office || null;
  const loPath = (lo && lo.path) || '';
  const loOk = !!(lo && lo.healthy === true);
  const loChecking = officeBusy || !!(lo && lo.installed && lo.verified == null);
  const loMissing = !lo || !lo.installed;
  const loFailed = !loChecking && !loMissing && !loOk;
  const installing = !!(officeInstall && officeInstall.busy);
  const installFailed = !!(officeInstall && officeInstall.stage === 'error');
  const installPercent = Math.max(0, Math.min(100, Number(officeInstall && officeInstall.percent) || 0));
  const downloadLabel = installing ? 'Installing…' : (loOk ? 'Clean reinstall' : 'Download LibreOffice');

  const chooseOutput = async (activate) => {
    try {
      const f = await api.pickFolder();
      if (!f) return;
      await setSettings(activate ? { outputMode: 'custom', customOutput: f } : { customOutput: f });
    } catch (e) {
      toast(errorText(e, 'That folder could not be saved.'), 'error');
    }
  };
  const chooseOutputMode = (mode) => {
    if (mode === 'custom' && !s.customOutput) chooseOutput(true);
    else change({ outputMode: mode });
  };
  const openOutput = async () => {
    try { await api.openOutput(); }
    catch (e) { toast(errorText(e, 'The output folder could not be opened.'), 'error'); }
  };
  const change = (patch) => {
    setSettings(patch).catch((e) => toast(errorText(e, 'That setting could not be saved.'), 'error'));
  };

  return (
    <div className="page narrow">
      <PageHeader title="Settings" sub="Make MorphEra yours." />
      <Card>
        <Field label="Appearance"><Segmented value={s.theme} onChange={(v) => change({ theme: v })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} /></Field>
      </Card>
      <Card>
        <Field label="Where converted files go" hint={info.outputNote || undefined}>
          <Segmented value={s.outputMode} onChange={chooseOutputMode} options={[{ value: 'beside', label: 'Next to MorphEra' }, { value: 'folder', label: 'Inside a "MorphEra Files" folder' }, { value: 'custom', label: 'Custom folder' }]} />
        </Field>
        {s.outputMode === 'custom' && <div className="row"><div className="path-box grow">{s.customOutput || 'No folder chosen'}</div><Button icon="folder" onClick={() => chooseOutput(false)}>Choose</Button></div>}
        <div className="row"><div className="path-box grow">{info.outputDir}</div><Button icon="external" onClick={openOutput}>Open</Button></div>
      </Card>

      <Card className="office-card">
        <div className="office-card-head">
          <div className="office-card-icon"><Icon name="file" size={20} /></div>
          <div className="grow">
            <b>Document engine</b>
            <div className="muted small">LibreOffice is required for Word, Excel, PowerPoint, OpenDocument and RTF files. It is free and runs offline.</div>
          </div>
          <span className={`office-req ${loOk ? 'ok' : ''}`}>{loOk ? 'Ready' : 'Required'}</span>
        </div>

        <div className={`office-gate-status ${loChecking ? 'checking' : loMissing ? 'missing' : loFailed ? 'failed' : 'ok'}`}>
          <span className="office-gate-dot" aria-hidden="true" />
          <div className="grow">
            {loChecking ? (
              <>
                <b>Checking your installation…</b>
                <span>Looking for LibreOffice and making sure it starts.</span>
              </>
            ) : loMissing ? (
              <>
                <b>LibreOffice was not found</b>
                <span>Install it with the button below, then click “Check again”.</span>
              </>
            ) : loFailed ? (
              <>
                <b>LibreOffice was found, but it could not start</b>
                <span>{lo.error || 'Close any open LibreOffice windows and try again, or locate the program manually.'}</span>
              </>
            ) : (
              <>
                <b>LibreOffice is ready{lo.version && lo.version !== 'unknown' ? ` · ${lo.version}` : ''}</b>
                <span className="mono">{loPath}</span>
                {lo.warning && <span>{lo.warning}</span>}
              </>
            )}
          </div>
        </div>

        {(installing || installFailed) && (
          <div className={`office-install ${installFailed ? 'failed' : ''}`} role="status" aria-live="polite">
            <div className="office-install-meta">
              <span>{officeInstall.message || 'Preparing LibreOffice…'}</span>
              <span>{Math.round(installPercent)}%</span>
            </div>
            <Progress value={installPercent / 100} />
            <div className="office-install-foot">
              <span>
                {officeInstall.total && officeInstall.received
                  ? `${fmtBytes(officeInstall.received)} of ${fmtBytes(officeInstall.total)}`
                  : officeInstall.stage === 'install'
                    ? 'Approve the Windows administrator prompt if it appears.'
                    : 'MorphEra downloads only from the official Document Foundation mirror.'}
              </span>
              {officeInstall.cancellable && <Button variant="ghost" onClick={cancelOfficeInstall}>Cancel</Button>}
            </div>
          </div>
        )}

        <div className="office-card-actions">
          <Button variant="primary" icon="download" onClick={installOffice} disabled={installing || officeBusy}>{downloadLabel}</Button>
          <Button variant="soft" icon="refresh" onClick={refreshOffice} disabled={officeBusy || installing}>{officeBusy ? 'Checking…' : 'Check again'}</Button>
          <Button variant="ghost" icon="folder" onClick={locateOffice} disabled={officeBusy || installing}>Locate manually</Button>
        </div>
        <div className="hint">If you installed LibreOffice somewhere unusual, use “Locate manually” and choose the <span className="mono">soffice</span> program.</div>
      </Card>

      <Card>
        <Toggle checked={s.notify} onChange={(v) => change({ notify: v })} label="Notify me when conversions finish" />
        <Toggle checked={s.openAfter} onChange={(v) => change({ openAfter: v })} label="Show the file in its folder when done" />
      </Card>
      <Card className="about">
        <Logo size={44} />
        <div><b>MorphEra</b><div className="muted">Version {info.version} · Everything runs on your computer. Nothing is uploaded.</div>
          <div className="muted small">{loOk ? `LibreOffice found${lo.version && lo.version !== 'unknown' ? ` (${lo.version})` : ''}: all document formats are enabled.` : 'LibreOffice is required. Install it above to enable document conversions.'}</div></div>
      </Card>
    </div>
  );
}
