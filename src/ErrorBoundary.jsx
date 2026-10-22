import React from 'react';
import { Logo, Button, Icon } from './ui.jsx';

/**
 * Last line of defence for rendering errors. A malformed file should never
 * leave a blank window with no way back.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[MorphEra] UI crashed', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app">
        <div className="bg" aria-hidden="true"><i className="blob b1" /><i className="blob b2" /><i className="blob b3" /><div className="grain" /></div>
        <div className="crash-screen">
          <div className="crash-card glass">
            <Logo size={48} />
            <h1>Something went wrong</h1>
            <p>MorphEra hit an unexpected problem while drawing this page. Your files and conversions are safe.</p>
            <div className="crash-detail mono">{String((this.state.error && this.state.error.message) || this.state.error)}</div>
            <div className="btnrow">
              <Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>Reload MorphEra</Button>
              <Button variant="ghost" icon="folder" onClick={() => this.setState({ error: null })}>Try to continue</Button>
            </div>
            <div className="hint"><Icon name="info" size={13} /> If this keeps happening, restart the app.</div>
          </div>
        </div>
      </div>
    );
  }
}
