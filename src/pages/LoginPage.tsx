import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Lock, Layers } from 'lucide-react';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    setError('');
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-proof flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8">
          <Layers size={20} className="text-orange" />
          <span className="font-mono text-sm tracking-widest uppercase text-ink">SchemaForge</span>
        </div>

        <div className="proof-card p-8">
          <h1 className="text-lg font-semibold text-ink mb-1">Acceso operador</h1>
          <p className="text-xs text-ink-muted font-mono mb-6">Herramienta interna — Sharpen.Studio</p>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-ink-muted mb-1">
                Correo electrónico
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSignIn()}
                className="input-field w-full"
                placeholder="operador@sharpen.studio"
                autoComplete="email"
              />
            </div>

            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-ink-muted mb-1">
                Contraseña
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSignIn()}
                className="input-field w-full"
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </div>

            {error && (
              <p className="text-xs font-mono text-orange border border-orange/30 bg-orange/5 px-3 py-2 rounded">
                {error}
              </p>
            )}

            <button
              onClick={handleSignIn}
              disabled={loading || !email || !password}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              <Lock size={14} />
              {loading ? 'Entrando...' : 'Entrar'}
            </button>
          </div>
        </div>

        <p className="text-center text-xs font-mono text-ink-muted mt-6">
          Sin acceso público — solo operadores autorizados
        </p>
      </div>
    </div>
  );
}
