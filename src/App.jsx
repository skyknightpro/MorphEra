import React from 'react';
import { Provider, useApp } from './store.jsx';
import { TitleBar, Sidebar, Dock, Toasts, DropOverlay } from './shell.jsx';
import { motion, AnimatePresence } from './ui.jsx';
import LibreOfficeGate from './LibreOfficeGate.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import Convert from './pages/Convert.jsx';
import Compress from './pages/Compress.jsx';
import ImageStudio from './pages/ImageStudio.jsx';
import Media from './pages/Media.jsx';
import PdfTools from './pages/PdfTools.jsx';
import Presets from './pages/Presets.jsx';
import Watch from './pages/Watch.jsx';
import History from './pages/History.jsx';
import Settings from './pages/Settings.jsx';

const PAGES = { convert: Convert, compress: Compress, image: ImageStudio, media: Media, pdf: PdfTools, presets: Presets, watch: Watch, history: History, settings: Settings };

function Shell() {
  const { route, info } = useApp();
  const Page = PAGES[route] || Convert;
  return (
    <div className="app">
      <div className="bg" aria-hidden="true"><i className="blob b1" /><i className="blob b2" /><i className="blob b3" /><div className="grain" /></div>
      <TitleBar />
      <div className="body">
        <Sidebar />
        <main className="content">
          {info && (
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={route} className="route" initial={{ opacity: 0, y: 14, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -8, filter: 'blur(4px)' }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}>
                <Page />
              </motion.div>
            </AnimatePresence>
          )}
        </main>
      </div>
      <Dock />
      <Toasts />
      <DropOverlay />
      <LibreOfficeGate />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <Provider>
        <Shell />
      </Provider>
    </ErrorBoundary>
  );
}
