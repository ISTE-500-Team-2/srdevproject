import { Filter } from "lucide-react"
import { Toast } from "../components/Toast"
import { Modal } from "../components/Modal"

function CertWaiverEditModal(){
    return(
        {/**TODO */}
    )//end of return
}//end of CertWiaverEditModal

function CertWaiverListEntry(){
    return(
        <li className="admin-certwaiver-list-entry">
            <button>
                {/** TODO implement writing functionality */}
            </button>
            <h3>Certname</h3>
            <p>Version Number</p>
            <p>Description</p>
        </li>
    )//end of return
} //end of CertWaiverListEntry

function CertWaiverColumn() {
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

                </ul>
            </div>{/**Column list wrapper*/}
        </div>
    )//end of return
}//end of CertWaiverColumn

export function AdminCertificationsPage() {
    return (
        <div className="admin-certifications page-enter">
            
        </div>
    )//end of return
}//default export