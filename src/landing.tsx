// Server-rendered public homepage. Anyone can read this without signing in; the signed-in app replaces it on the client.
export function Landing({ returnTo = '/' }: { returnTo?: string }) {
  return <>
    <header className="topbar"><a className="brand" href="/"><img className="logo" src="/logo.png" alt="GAINS" width="512" height="512" /><span>TRAINING REMOTE</span></a></header>
    <main>
      <section className="hero">
        <p className="eyebrow">READY WHEN YOU ARE</p>
        <h1>Your plan.<br />Your performance.</h1>
        <p>GAINS is a strength-training remote. You agree on a concrete workout with ChatGPT, then record what you actually lift in the GAINS web app, set by set.</p>
        <a className="button" href={`/login?returnTo=${encodeURIComponent(returnTo)}`}>Continue with Google</a>
      </section>
      <section>
        <h2>How it works</h2>
        <ol>
          <li><strong>Agree in ChatGPT.</strong> Discuss a workout with ChatGPT and ask it to save the exact exercises, sets, reps, loads and rest periods to your GAINS account.</li>
          <li><strong>Start in GAINS.</strong> Open the saved workout on your phone or computer and start a session.</li>
          <li><strong>Record each set.</strong> Confirm the reps and load you performed, skip what you did not do, and correct entries when needed.</li>
          <li><strong>Review your history.</strong> Finished sessions stay in your history, and ChatGPT can read them when you ask about your training.</li>
        </ol>
      </section>
      <section>
        <h2>What GAINS does not do</h2>
        <p>GAINS does not generate workouts, coach you, or manage a program. Planned targets and your recorded results are stored separately, so the plan never overwrites what you actually did.</p>
      </section>
      <section>
        <h2>Your data</h2>
        <p>Google sign-in identifies your GAINS account using your name and email address. GAINS does not show advertising and does not sell your data. The <a href="/privacy">privacy policy</a> explains what is stored, who processes it, how long it is kept, and how to request deletion.</p>
      </section>
    </main>
    <footer>Prescribed in chat. Performed by you. · <a href="/privacy">Privacy policy</a></footer>
  </>
}
