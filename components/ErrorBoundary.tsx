import React from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Headline shown in place of the crashed screen. */
  title?: string;
  /** Explanation under the headline. */
  message?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Contains a render-time exception to the screen that threw it. Without a boundary React unmounts the
 * whole tree, so one bad record (or an invalid date in a form) blanked the entire console — or a
 * candidate's exam — with no way back short of guessing to reload. Give it a `key` that changes when
 * the user navigates so a fresh screen gets a fresh boundary.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Screen crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="lsc-panel mx-auto my-8 max-w-lg p-6 text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-amber-50 text-amber-600">
          <AlertTriangle size={22} />
        </div>
        <h2 className="text-base font-semibold text-slate-900">{this.props.title || 'Something went wrong on this screen'}</h2>
        <p className="mt-1.5 text-sm text-slate-600">
          {this.props.message || 'The rest of the app is unaffected. Reload the page to try again.'}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="lsc-button-primary mx-auto mt-5 inline-flex items-center gap-2 px-4 py-2 text-sm"
        >
          <RotateCw size={15} /> Reload page
        </button>
      </div>
    );
  }
}
