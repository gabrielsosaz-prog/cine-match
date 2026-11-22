import { Component, type ReactNode } from 'react';

/**
 * Si una pantalla falla al dibujarse, se muestra un aviso con «Reintentar» en lugar de dejar la app en blanco.
 * No toca los datos guardados.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(prev: { resetKey?: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: undefined }); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" data-testid="screen-error" className="space-y-2 rounded-2xl bg-red-500/10 p-4 text-sm text-red-100">
        <p className="font-semibold">Esta pantalla tuvo un problema al mostrarse.</p>
        <p>Tus valoraciones y marcas siguen guardadas en el dispositivo.</p>
        <p className="text-[11px] text-red-200/70">Detalle: {this.state.error.message}</p>
        <button type="button" className="rounded-lg bg-ink-800 px-3 py-1.5 font-semibold" onClick={() => this.setState({ error: undefined })}>Reintentar</button>
      </div>
    );
  }
}
