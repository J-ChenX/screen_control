import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <main className="fatal-error" role="alert">
        <span>!</span>
        <h1>Portal 无法显示当前页面</h1>
        <p>界面发生了未恢复错误；没有自动重试任何设备或文件操作。</p>
        <button onClick={() => window.location.assign("/")}>返回设备总览</button>
      </main>
    );
  }
}
