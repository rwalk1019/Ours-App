import { lazy, Suspense, useState } from 'react';
import { LiveApp } from './live/LiveApp';

const DemoApp = lazy(() => import('./demo/DemoApp').then((mod) => ({ default: mod.DemoApp })));

export function App() {
  const [demo, setDemo] = useState(false);
  if (demo) {
    return (
      <Suspense fallback={<main className="mx-auto min-h-dvh max-w-md bg-paper" />}>
        <DemoApp onLeave={() => setDemo(false)} />
      </Suspense>
    );
  }
  return (
    <div className="min-h-dvh bg-[#e7d5c3]">
      <LiveApp onDemo={() => setDemo(true)} />
    </div>
  );
}
