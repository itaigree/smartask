const ENV_SNIPPET = `NOTION_TOKEN=ntn_…
NOTION_PARENT_PAGE_ID=<paste the Notion page link>`;

const SETUP_SNIPPET = `npm run setup:notion
# then put the id it prints into .env.local:
NOTION_DATABASE_ID=…`;

/**
 * Shown instead of the board when Notion is not configured, so a fresh clone
 * explains itself rather than crashing (PLAN.md decision 5). Server component.
 */
export default function SetupNotice({ reason }: { reason?: string }) {
  return (
    <div className="setup">
      <h2>Connect Notion to get started</h2>
      <p>
        {reason ??
          'SmartTask keeps every task in a Notion database, so there is nothing else to host.'}
      </p>
      <ol>
        <li>
          Create an integration at{' '}
          <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer">
            notion.so/my-integrations
          </a>{' '}
          and copy its <em>Internal Integration Secret</em>.
        </li>
        <li>
          Open the Notion page the task database should live in, then{' '}
          <strong>••• → Connections</strong> and add that integration.
        </li>
        <li>
          Put both values in <code>.env.local</code>:
          <pre>{ENV_SNIPPET}</pre>
        </li>
        <li>
          Create the database:
          <pre>{SETUP_SNIPPET}</pre>
        </li>
        <li>
          Restart the dev server. Full details are in <code>README.md</code>.
        </li>
      </ol>
    </div>
  );
}
