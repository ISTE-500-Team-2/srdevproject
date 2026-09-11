import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return <div className="not-found page-enter"><p className="eyebrow">404 · Lost in the shop</p><h1>That project isn’t on this bench.</h1><p>The page may have moved, or the prototype route is not built yet.</p><Link className="button button--primary" to="/"><ArrowLeft aria-hidden="true" /> Back home</Link></div>;
}
