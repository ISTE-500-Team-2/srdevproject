import { ChevronDown, Filter } from "lucide-react";
import {
    classes
} from "../data/mockData";
import '../assets/css/analyticsDashboard.css';

/**
 * The component for displaying the list of classes
 * @returns 
 */
function AnalyticsWorkshopClasses() {
    return (
        <div className="analytics__workshop-classes"> {/**the wrapper for the list of classes */}
            <ul>
                {classes.map((wsClass) => (
                    <li className="analytics__workshop-class">
                        <button >
                            <h4 className="analytics__workshop-class__header">
                                <span className="analytics__workshop-class__header-title">
                                    {wsClass.title}
                                </span>
                                <b className="analytics__workshop-class__header-occupancy">
                                    {wsClass.enrolled} / {wsClass.capacity} slots
                                </b>
                            </h4> {/**end of class item header */}
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
                        </button>
                    </li>
                ))/**End of classes.map */}
            </ul>
            <hr/>
            <div className="analytics__workshop-classes__footer">
                Filter Classes <Filter />
            </div>
        </div>
    ); //end of return
}//AnalyticsWorkshopClasses

/**
 * The small segment that displays the number of currently active users
 * @returns 
 */
function ActiveUserDisplay() {
    return (
        <div className="analytics-active-users">
            <div className="analytics-active-users__info">
                <small>Right Now</small> <br/>
                <strong>Active Users: 56</strong>
            </div> {/**end of info column */}
        </div>
    ); //end of return
}//ActiveUserDisplay

/**
 * The column which holds the users and classes
 */
function UsersAndClassesCol(){
    return (
        <aside className="admin-sidebar panel">
            <ActiveUserDisplay/>
            <AnalyticsWorkshopClasses/>
        </aside>
    ); //end of return
}//UsersAndClassesCol

export function AnalyticsDashboardPage() {
    return (
        <div className="analytics-dashboard page-enter">
            <UsersAndClassesCol/>
        {/** end of container*/}
        </div> 
    );//end of return
}//end of analyticsdashboardpage