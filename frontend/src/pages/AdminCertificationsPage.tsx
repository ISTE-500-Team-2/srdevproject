import { Filter } from "lucide-react"
import { Toast } from "../components/Toast"
import { Modal } from "../components/Modal"
import { certifications, waivers } from "../data/mockData"
import { api, errorMessage } from "../lib/api"
import { useApi } from "../lib/useApi"
import type { Certification, Waiver } from "../lib/contracts"

function CertWaiverEditModal(){
    return(
        {/**TODO */}
    )//end of return
}//end of CertWiaverEditModal

// function CertWaiverListEntry(certwaiver){
//     return(
//         <li className="admin-certwaiver-list-entry">
//             <button>
//                 {/** TODO implement writing functionality */}
//             </button>
//             <h3>Certname</h3>
//             <p>Version Number</p>
//             <p>Description</p>
//         </li>
//     )//end of return
// } //end of CertWaiverListEntry

function CertWaiverColumn(certwaivers: any[]) {
    return (
        <div className="admin-certwaiver-column">
            <div className="admin-certwaiver-column-header">
                <h2>
                    {/**TODO implement title changing depending on waivers or certs */}
                    Title
                </h2>
                <button>
                    {/**TODO implement filter functionality */}
                    <Filter />
                    Filter
                </button>
            </div>{/**Column header*/}
            <div className="admin-certwaiver-column-list-wrapper">
                <ul>
                    { certwaivers.map((certwaiver) => (
                        <li>
                            <h3>{certwaiver.name}</h3>
                            <p></p>
                        </li>
                    )
                    )} {/** end of repeat */}
                </ul>
            </div>{/**Column list wrapper*/}
        </div>
    )//end of return
}//end of CertWaiverColumn

export function AdminCertificationsPage() {
    const waivers = useApi<Waiver[]>(`me/waivers`); //TODO endpoint for all of them
    const certifications = useApi<Certification[]>(`me/certifications`);
    return (
        <div className="admin-certifications page-enter">
            
        </div>
    )//end of return
}//default export