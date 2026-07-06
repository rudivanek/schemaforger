import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Layers, LogOut, LayoutGrid, BookTemplate } from 'lucide-react';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  const isActive = (path: string) => location.pathname === path;

  return (
    <div className="min-h-screen bg-proof flex flex-col">
      <header className="bg-white border-b border-rule h-12 flex items-center px-4 shrink-0">
        <div className="flex items-center gap-2 mr-8">
          <Layers size={16} className="text-orange" />
          <span className="font-mono text-xs tracking-widest uppercase text-ink font-semibold"><span className="text-[10px] font-normal normal-case tracking-normal opacity-50 mr-1.5">v 1.7</span>SchemaForge</span>
        </div>
        <nav className="flex items-center gap-1 flex-1">
          <Link
            to="/"
            className={`nav-link ${isActive('/') ? 'nav-link-active' : ''}`}
          >
            <LayoutGrid size={13} />
            Clientes
          </Link>
          <Link
            to="/templates"
            className={`nav-link ${isActive('/templates') ? 'nav-link-active' : ''}`}
          >
            <BookTemplate size={13} />
            Plantillas
          </Link>
        </nav>
        <button
          onClick={handleSignOut}
          className="flex items-center gap-1.5 text-xs font-mono text-ink-muted hover:text-ink transition-colors px-2 py-1 rounded hover:bg-proof"
        >
          <LogOut size={13} />
          Salir
        </button>
      </header>
      <main className="flex-1 p-6 max-w-screen-xl mx-auto w-full">
        {children}
      </main>
    </div>
  );
}
