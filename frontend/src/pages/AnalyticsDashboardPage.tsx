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

/**
 * Creates a revenue value for each interval.
 * @param intervals 
 * @param payments 
 * @returns 
 */
function createRevenuesAtIntervals(intervals: Date[], payments: Payment[]){
    let revenues: number[] = [];

    //i is the interval date.
    for(var i of intervals){
        const p = payConsolidation(payments, i);
        if(p){
            revenues.push(p)
        }
    }//end of forloop

    return revenues;
}//createRevenuesAtIntervals

/**
 * A helper function which returns an array of starting dates
 * @param basis 
 * @param amount 
 * @param mode 
 */
function createIntervals(basis: Date, amount: number = 4, mode = `weekly`){
    let intervals: Date[] = []; //array of intervals to return
    // let fxn; //the function used to calculate the starting dates of each interval.
    let prev = basis
    for(let i=0; i<amount; i++){
        intervals.push(prev)
        switch(mode) {
            case `weekly`:
                prev = new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() -7);
                break;
            case `monthly`:
                prev = new Date(prev.getFullYear(), prev.getMonth() -1, 1);
                break;
            case `yearly`:
                prev = new Date(prev.getFullYear() -1);
            case `quarterly`:
                break;
        }//end of switch based on mode
    }//end of forloop
    
    return intervals;
}//createIntervals

/**
 * A helper function designed to get the end dates of a start date provided.
 * @param startDate 
 * @param mode 
 * @returns 
 */
function calculateEndDate(startDate: Date, mode = 'weekly'){
    let endDate;

    
    switch (mode) {
        case `weekly`:
            endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() +7)
            break;
        case `monthly`:
            endDate = new Date(startDate.getFullYear(), startDate.getMonth() +1, 0)
            break;
        case `quarterly`:
            break;
        case `yearly` :
            endDate = new Date(startDate.getFullYear() +1, 0, 0)
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
function payConsolidation(array: Payment[], startDate: Date, mode = `weekly`){
    let endDate;
    //attempting to filter for now.

    endDate = calculateEndDate(startDate, mode)
    let sDate = new Date(startDate); //converted to date datatype

    //if endDate is not null, begin filtering
    if(endDate){
        //array of filtered payments
        let filtered = array.filter((p) => {
            //p is the payment that is in the array.
            let pDate = new Date(p.recordedAt);

            return pDate.getTime() >= sDate.getTime() && pDate.getTime() <= endDate?.getTime()
        })

        return filtered.reduce((a, item) => {
            return a + Number(item.amount); //convert ammount to number and accumulate
        }, 0)
    }//end of if statement
}//payConsolidation


function AnalyticsRevenueChart(){
    //Get the payments from the api.
    const payments = useApi<Payment[]>('/admin/payments');
    console.log(payments.data?.length);
    let payData = []; //array containing
    let intervals = createIntervals(new Date())
    let revenues: number[] = [];
    // let payArray; //the interpreted and consumed information as a neet array.
    if(!payments.loading && !payments.error && payments.data?.length){
        // const payArray = payments.data?.map
        revenues = createRevenuesAtIntervals(intervals, payments.data) //record the revenues for each interval
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
                    
                    <LineChart values={revenues} labels={intervals} max={6000} /><div className="metric-card__footer">
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