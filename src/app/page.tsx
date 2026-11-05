import App from '../components/App.tsx';

/**
 * The only route. Everything happens in the browser: there is no server to ask
 * (PLAN.md decision 6b), so this page is a static shell around the client app.
 */
export default function Home() {
  return <App />;
}
