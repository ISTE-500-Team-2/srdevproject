//All links contained in the navbar.
const NavbarLinks = [
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