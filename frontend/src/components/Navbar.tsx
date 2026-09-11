import { Link } from "react-router-dom";

//All links contained in the navbar.
//Label is the text that will be displayed in the element.
//path is the url or path to the linked page.
//children is an array of similarly formatted and organized links below the parent.
//child links will be displayed upon hovering over the parent link, once the feature
//is implemented. For now, we only have the main links.
const navbarLinks = [
    {
        label: "Home",
        path: "/"
    },
    {
        label: "Reservations",
        path: "/reservations",
        children: [
            {
                label: "Equipment",
                path: "/reservations/equipment"
            },
            {
                label: "Studio Spaces",
                path: "/reservations/spaces"
            }
        ] //children
    }, //reservations
    {
        label: "Certifications",
        path: "/certifications",
        children: [
            {
                label: "My Certifications",
                path: "/profile"
            },
            {
                label: "Classes",
                path: "/certifications/profile"
            }
        ]
    }, //Certifications
];

export function Navbar(){
    return(
        <nav id="main-navbar">
            <ul>
                {navbarLinks.map((mainlink) => (
                    <li key={mainlink.label}>
                        <div className="main-navbar-link-wrapper">
                            <Link to={mainlink.path}>{mainlink.label}</Link>
                        </div>
                    </li>
                ))}
            </ul>
        </nav>
    ); //return
}//export