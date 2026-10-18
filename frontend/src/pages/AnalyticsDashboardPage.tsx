import { ChevronDown, Filter } from "lucide-react";
import {
    classes
} from "../data/mockData";
import '../assets/css/analyticsDashboard.css';
import { LineChart } from "../components/Charts";
import { useApi } from "../lib/useApi";
import { Payment } from "../lib/staffContracts";

import { revenueSeries } from "../data/mockData";
const mockLabels = ["Apr 12", "Apr 13", "Apr 14", "Apr 15", "Apr 16", "Apr 17"];


function calculateEndDate(startDate: string, mode = 'weekly'){
    let endDate;

    const toDate = new Date(startDate); //should convert the string to a date.
        switch (mode) {
        case `weekly`:
            endDate = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() +7)
            break;
        case `monthly`:
            endDate = new Date(toDate.getFullYear(), toDate.getMonth() +1, toDate.getDate())
            break;
        case `quarterly`:
            break;
        case `yearly` :
            break;
        default:
            return
    }
    return endDate;
}//calculateEndDate

/**
 * A helper function to reduce an array of payments so that we are left with the sum of
 * all payments made within a certain period of time after a specified date
 * @param array - Array of Payment objects
 * @param startDate - the starting date in yyyy/mm/dd format
 * @param mode 
 */
function payConsolidation(array: Payment[], startDate: string, mode = `weekly`){
    let endDate;
    //attempting to filter for now.
    let result = array.filter((p) => new Date(p.recordedAt).getTime() >= startDate && new Date(p.recordedAt).getTime <= calculateEndDate(startDate)?.getTime() && p.recordedAt)
}//payConsolidation


function AnalyticsRevenueChart(){
    //Get the payments from the api.
    const payments = useApi<Payment[]>('/admin/payments');
    console.log(payments.data?.length)
    let payArray; //the interpreted and consumed information as a neet array.
    if(!payments.loading && !payments.error && payments.data?.length){
        const payArray = payments.data?.map
        const weekpay = payConsolidation(payments.data)
    }
    return(
        <article className="metric-card metric-card--wide panel">
            {payments.loading ? (
                <p role="status">Loading Payments...</p>
            ) : payments.error ? (
                <p role="alert">
                    There was an error
                    <button onClick={payments.reload}>Retry</button>
                </p>
            ) : null
            } {/** Display for loading and for errors */}

            { /**Display when there are no payments recorded */
                !payments.loading && !payments.error && !payments.data?.length ? (
                    <p>No payments recorded</p>
                ) :null
            }
            {payments.data?.length ? (
                <>
                {/** gets an array of the amounts of payments */}
                    <LineChart values={payments.data?.map(({ amount }) => parseFloat(amount))} labels={mockLabels} max={6000} /><div className="metric-card__footer">
                    <div>
                        <small>Gross Revenue</small>
                        <strong>
                            
                        </strong>
                    </div> {/** Metric */}
                    </div>
                </> 
            ) : null
            }
        </article>
    );
}//AnalyticsRevenueChart

/**
 * Creates the charts for all the admin metrics
 */
function AnalyticsCharts(){
    return(
        <section className="admin-metrics">
            <AnalyticsRevenueChart/>
        </section>
    ); //return
}//AnalyticsCharts

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
                        <button className="analytics__ws-class">
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
            <AnalyticsCharts/>
        {/** end of container*/}
        </div> 
    );//end of return
}//end of analyticsdashboardpage