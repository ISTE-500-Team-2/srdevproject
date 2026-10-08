import { ChevronDown, Filter } from "lucide-react";
import {
    classes
} from "../data/mockData";

/**
 * The component for displaying the list of classes
 * @returns 
 */
function AnalyticsWorkshopCalsses() {
    return (
        <div className="analytics__workshop-classes">
            <ul>
                {classes.map((wsClass) => (
                    <li className="analytics__workshop-class">
                        <div className="analytics__workshop-class__header">
                            <span className="analytics__workshop-class__header-title">
                                {wsClass.title}
                            </span>
                            <span className="analytics__workshop-class__header-occupancy">
                                {wsClass.enrolled} / {wsClass.capacity} slots
                            </span>
                        </div> {/**end of class item header */}
                        <div className="analytics__workshop-class__admin-info">
                            <div className="analytics__workshop-class__col1">
                                <p>Instructor: {wsClass.instructor}</p>
                                <p>Equipment: {wsClass.equipment}</p>
                            </div> {/**end of col1 */}
                            <time className="analytics__workshop-class__col2">
                                {wsClass.date}
                                <small>{wsClass.time}</small>
                            </time> {/**end of col2 */}
                        </div>{/**end of admin info */}
                        
                        <ChevronDown aria-hidden="true"/>
                        
                        <div className="analytics__workshop-class__moreinfo">
                            <p>
                                {wsClass.description}
                            </p>
                        </div>
                    </li>
                ))/**End of classes.map */}
            </ul>
            <hr/>
            <div className="analytics__workshop-classes__footer">
                Filter Classes <Filter />
            </div>
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