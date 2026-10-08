import { createFileRoute } from '@tanstack/react-router'
export const Route = createFileRoute('/privacy')({
  head: () => ({ meta: [{ title: 'Privacy policy · GAINS' }, { name: 'description', content: 'How GAINS collects, uses, shares, keeps and deletes personal data, including Google account data and the ChatGPT connection.' }] }),
  component: Privacy,
})
function Privacy() {
  return <>
    <header className="topbar"><a className="brand" href="/"><img className="logo" src="/logo.png" alt="GAINS" width="512" height="512" /><span>TRAINING REMOTE</span></a></header>
    <main>
      <p className="eyebrow">PRIVACY POLICY</p>
      <h1>Privacy policy</h1>
      <p className="muted">Last updated: 8 October 2026</p>

      <section>
        <p>This policy explains how GAINS (the strength-training remote available at gains.codictive.be, together with its ChatGPT connection) handles personal data. GAINS is operated by <strong>[legal name of the operator, registered address and company number]</strong>. For privacy questions and requests, contact <strong>[privacy contact email address]</strong>.</p>
      </section>

      <section>
        <h2>1. Data we collect</h2>
        <ul>
          <li><strong>Google account information.</strong> When you sign in with Google, we receive your name, email address, whether that email is verified, your profile picture URL, and Google's stable identifier for your account. Google sign-in requests the <code>openid</code>, <code>profile</code> and <code>email</code> scopes.</li>
          <li><strong>Training data.</strong> Exercise names, workouts (titles, notes, exercise instructions, planned sets with target reps, loads, RPE and rest periods), training sessions, and what you actually performed: completed, skipped or pending sets, reps, loads, RPE, notes and timestamps.</li>
          <li><strong>ChatGPT connection records.</strong> The name of the connected client, the permissions you approved, when access was granted, and the OAuth access and refresh tokens that keep the connection working. You can disconnect at any time.</li>
          <li><strong>Sign-in and security data.</strong> Session records that include your IP address and browser user agent, and request counters used to limit abusive traffic.</li>
          <li><strong>Operation records.</strong> Identifiers and a fingerprint of each change you saved, so that a retried save is not recorded twice.</li>
          <li><strong>Error logs.</strong> When something fails, we log a request ID, the operation name, the error message and code locations. Request contents, bearer tokens and database connection strings are not logged.</li>
          <li><strong>Data on your device.</strong> The browser keeps workout drafts, unsent changes and the session you have open in IndexedDB, so you can keep training offline. A service worker caches only the empty app shell and public files, never your training data or responses from the server. This data stays on your device until it is synced or you clear site data.</li>
        </ul>
        <p>GAINS does not use cookies for advertising or analytics. It uses a sign-in session cookie that is necessary to keep you signed in.</p>
      </section>

      <section>
        <h2>2. How we use data</h2>
        <ul>
          <li>To sign you in and identify your account.</li>
          <li>To store, display and synchronise your workouts, training sessions and results.</li>
          <li>To let ChatGPT read your training results and manage your upcoming workouts, but only after you approve that connection.</li>
          <li>To keep accounts secure, prevent abuse, and investigate and fix errors.</li>
        </ul>
        <p>We do not sell your data, show advertising with it, or build advertising profiles. GAINS itself does not train AI models on your data.</p>
      </section>

      <section>
        <h2>3. Google user data</h2>
        <p>GAINS's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">Google API Services User Data Policy</a>, including the Limited Use requirements. Google data is used only to sign you in and identify your account.</p>
      </section>

      <section>
        <h2>4. Legal basis (EEA and Belgium)</h2>
        <p>We process personal data to provide the service you asked for (performance of a contract), to keep it secure (our legitimate interest in protecting accounts and the service), and to meet legal obligations. Connecting ChatGPT is based on your explicit approval, which you can withdraw by disconnecting it.</p>
      </section>

      <section>
        <h2>5. Who receives your data</h2>
        <ul>
          <li><strong>Google</strong>, which provides sign-in.</li>
          <li><strong>Database hosting</strong>: [name of PostgreSQL provider, for example Neon], which stores the application data.</li>
          <li><strong>Server hosting</strong>: DigitalOcean, which runs GAINS.</li>
          <li><strong>ChatGPT (OpenAI)</strong>, only if you connect it. ChatGPT receives the workout and training data it requests through the connection, and handles that data under its own terms and privacy policy.</li>
          <li><strong>Authorities</strong>, where the law requires it.</li>
        </ul>
        <p>Where a provider processes data outside the European Economic Area, we rely on the safeguards that the law requires, such as the EU-US Data Privacy Framework or the European Commission's Standard Contractual Clauses.</p>
      </section>

      <section>
        <h2>6. How long we keep data</h2>
        <p>We keep your account and training data while your account is active. Sign-in sessions expire automatically. Error logs are kept for 30 days and then deleted. When you ask us to delete your account, we delete your account, Google profile data, training data and ChatGPT connection records. Copies held in backups are overwritten on their normal rotation, which is [backup retention period].</p>
      </section>

      <section>
        <h2>7. Your choices and rights</h2>
        <ul>
          <li><strong>Disconnect ChatGPT</strong> in account settings at any time.</li>
          <li><strong>Sign out</strong> in account settings. Local drafts stay on your device only if you choose to keep them.</li>
          <li><strong>Revoke Google access</strong> at myaccount.google.com/permissions.</li>
          <li><strong>Request access, correction, a copy of your data, deletion, or restriction</strong> by writing to the privacy contact above. You may also object to processing based on legitimate interests and withdraw consent where we rely on it.</li>
          <li><strong>Complain</strong> to the Belgian supervisory authority, the Gegevensbeschermingsautoriteit / Autorité de protection des données (gegevensbeschermingsautoriteit.be), or to the authority in your country of residence.</li>
        </ul>
        <p>We respond to requests within one month, as the GDPR requires.</p>
      </section>

      <section>
        <h2>8. Security</h2>
        <p>The production service is served only over HTTPS. Credentials are kept in environment secrets and not in source code. Access to production data is limited to the people who operate GAINS. No system is perfectly secure, so if we learn of a breach affecting your data, we will tell you as the law requires.</p>
      </section>

      <section>
        <h2>9. Children</h2>
        <p>GAINS is not directed at children under 16, and we do not knowingly collect their data. If you believe a child has given us data, contact us and we will delete it.</p>
      </section>

      <section>
        <h2>10. Changes to this policy</h2>
        <p>We update this page when our practices change and revise the date above.</p>
      </section>
    </main>
    <footer><a href="/">GAINS</a> · Prescribed in chat. Performed by you.</footer>
  </>
}
