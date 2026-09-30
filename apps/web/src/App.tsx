const workflowCards = [
  { label: "Data Entry", count: 0, detail: "New and edited prescriptions" },
  { label: "Product Fill", count: 0, detail: "Ready for preparation" },
  { label: "Pharmacist Review", count: 0, detail: "Awaiting verification" },
  { label: "Ready", count: 0, detail: "Prepared for pickup" },
];

export function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">Rx</span>
          <div><strong>Pharmacy1OS</strong><small>Development workstation</small></div>
        </div>
        <nav>
          {["Dashboard", "Prescriptions", "Patients", "Prescribers", "Inventory", "Reports", "Administration"].map((item, index) => (
            <button className={index === 0 ? "nav-item active" : "nav-item"} key={item}>{item}</button>
          ))}
        </nav>
      </aside>

      <main>
        <header className="topbar">
          <div><p className="eyebrow">Pharmacy operations</p><h1>Dashboard</h1></div>
          <span className="prototype-badge">Prototype — no PHI</span>
        </header>

        <section className="notice">
          <strong>Development environment</strong>
          <span>This interface contains no patient data and is not approved for production pharmacy use.</span>
        </section>

        <section className="workflow-grid">
          {workflowCards.map((card) => (
            <article className="workflow-card" key={card.label}>
              <span>{card.label}</span><strong>{card.count}</strong><small>{card.detail}</small>
            </article>
          ))}
        </section>

        <section className="panel">
          <p className="eyebrow">Foundation status</p>
          <h2>Core platform</h2>
          <div className="status-list">
            <div><span>API service</span><strong>Scaffolded</strong></div>
            <div><span>PostgreSQL schema</span><strong>Scaffolded</strong></div>
            <div><span>Role model</span><strong>Scaffolded</strong></div>
            <div><span>Prescription workflow</span><strong>Next phase</strong></div>
          </div>
        </section>
      </main>
    </div>
  );
}
