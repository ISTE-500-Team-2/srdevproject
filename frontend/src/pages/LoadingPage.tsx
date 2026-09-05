import { Cog } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

export function LoadingPage() {
  const [progress, setProgress] = useState(0);
  const [params] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    const next = params.get('next') || '/';
    const started = performance.now();
    const duration = 1350;
    const interval = window.setInterval(() => {
      const elapsed = performance.now() - started;
      const nextProgress = Math.min(100, Math.round((elapsed / duration) * 100));
      setProgress(nextProgress);
      if (nextProgress >= 100) {
        window.clearInterval(interval);
        window.setTimeout(() => navigate(next, { replace: true }), 180);
      }
    }, 35);
    return () => window.clearInterval(interval);
  }, [navigate, params]);

  return (
    <main className="loading-page" id="main-content">
      <img src="/assets/collaboratory-logo.webp" alt="The Collaboratory" />
      <p>where <strong>INSPIRATION</strong> runs wild</p>
      <div
        className="loading-page__progress"
        role="progressbar"
        aria-label="Loading your workspace"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <Cog aria-hidden="true" />
        <span>{progress}%</span>
      </div>
      <small>Preparing your workshop dashboard…</small>
    </main>
  );
}
