import { classes } from "../data/mockData";
export function AnalyticsDashboard_Classes() {
    return (
        <div className="classes-list">
            {classes.map((item) => (
                <article className="admin-class" key={item.id}>
                    
                </article>
            )
            )//end of classes.map
            }
        {/** end of container*/}
        </div> 
    );//end of return
}//end of AnalayticsDashboard_Classes