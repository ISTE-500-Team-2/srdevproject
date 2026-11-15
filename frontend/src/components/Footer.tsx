// Footer navigation lists implemented destinations only; do not add help or social links until
// their content exists.

import { Link } from 'react-router-dom';

const footerLinks = [
  {
    title: 'Explore',
    links: [
      ['Home', '/'],
      ['Equipment', '/equipment'],
      ['Studios', '/studios'],
      ['Certifications', '/certifications'],
      ['Classes', '/classes'],
    ],
  },
  {
    title: 'Your account',
    links: [
      ['Profile & settings', '/profile'],
      ['Membership & passes', '/membership'],
    ],
  },
];

export function Footer() {
  return (
    <footer className="site-footer">
      <nav className="site-footer__grid" aria-label="Footer">
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
      </nav>
      <div className="site-footer__bottom">
        <p>© {new Date().getFullYear()} The Collaboratory</p>
      </div>
    </footer>
  );
}
