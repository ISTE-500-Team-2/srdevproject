import { Filter } from "lucide-react";

function ClassDisplay() {
    return (
        <li>
            
        </li>
    ); //end of return
}//ClassDisplay

function ClassesDisplay() {
    return (
        <div className="analytics-dashboard-classes-display">
            <ul>

            </ul>
            <hr/>
            <button>
                {/**TODO add button filtration system */}
                <Filter></Filter>
            </button>
        </div>
    ); //end of return
}//ClassesDisplay

function ActiveUserDisplay() {
    return (
        <div className="analytics-dashboard-active-users">
            <h2>
                Active Users:
                {/**TODO display active users */}
                52
            </h2>
        </div>
    ); //end of return
}//ActiveUserDisplay

export function AnalyticsDashboardPage() {
    return (
        <div className="analytics-dashboard page-enter">
        {/** end of container*/}
        </div> 
    );//end of return
}//end of analyticsdashboardpage