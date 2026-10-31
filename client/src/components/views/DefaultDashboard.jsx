export default function DefaultDashboard(props) {
  const {
    summary,
  } = props;
  return (
    <>
              <section className="stats-grid">
                {summary.map((card) => (
                  <article key={card.label} className="stat-card">
                    <p>{card.label}</p>
                    <strong>{card.value}</strong>
                    <span>{card.change}</span>
                  </article>
                ))}
              </section>
    </>
  );
}
