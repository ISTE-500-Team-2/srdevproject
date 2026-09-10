import { Link } from 'react-router-dom';

const footerLinks = [
  {
    title: 'Sitemap',
    links: [
      ['Home', '/'],
      ['Reservations', '/reservations'],
      ['Certifications', '/certifications'],
      ['Classes', '/classes'],
      ['Search', '/reservations'],
      ['Profile', '/profile'],
    ],
  },
  {
    title: 'Account',
    links: [
      ['Personal information', '/profile'],
      ['Security & Privacy', '/profile'],
      ['Payments', '/profile'],
      ['Membership details', '/profile'],
      ['Notification settings', '/profile'],
      ['Accessibility settings', '/profile'],
    ],
  },
  {
    title: 'Help',
    links: [
      ['Contact us', '/profile'],
      ['Refund policy', '/profile'],
      ['Frequently asked questions', '/profile'],
    ],
  },
];

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-footer__grid">
        {footerLinks.map((group) => (
          <section key={group.title}>
            <h2>{group.title}</h2>
            <ul>
              {group.links.map(([label, to]) => (
                <li key={label}>
                  <Link to={to}>{label}</Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="site-footer__bottom">
        <p>© 2026, The Crafty Studio</p>
        <div className="site-footer__socials" aria-label="Social links">
          <a href="#facebook" aria-label="Facebook">f</a>
          <a href="#instagram" aria-label="Instagram">◎</a>
          <a href="#youtube" aria-label="YouTube">▶</a>
          <a href="#tiktok" aria-label="TikTok">♪</a>
        </div>
      </div>
    </footer>
  );
}
