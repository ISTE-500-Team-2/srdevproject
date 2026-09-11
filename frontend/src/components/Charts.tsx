interface LineChartProps {
  values: number[];
  labels: string[];
  max: number;
  height?: number;
  compact?: boolean;
}

function points(values: number[], max: number, width: number, height: number) {
  const usableHeight = height - 42;
  const step = width / Math.max(values.length - 1, 1);
  return values
    .map((value, index) => `${index * step},${usableHeight - (value / max) * (usableHeight - 12)}`)
    .join(' ');
}

export function LineChart({ values, labels, max, height = 270, compact = false }: LineChartProps) {
  const width = 900;
  const linePoints = points(values, max, width, height);
  const areaPoints = `0,${height - 42} ${linePoints} ${width},${height - 42}`;
  const ticks = compact ? [0, max / 2, max] : [0, max / 3, (max * 2) / 3, max];

  return (
    <div className="chart-wrap" aria-label={`Line chart with latest value ${values.at(-1)}`} role="img">
      <svg viewBox={`-42 0 ${width + 48} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={`area-${compact ? 'small' : 'large'}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f89a24" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#f89a24" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => {
          const y = height - 42 - (tick / max) * (height - 54);
          return (
            <g key={tick}>
              <line x1="0" x2={width} y1={y} y2={y} className="chart-gridline" />
              <text x="-12" y={y + 5} textAnchor="end" className="chart-label">
                {tick === 0 ? '0' : `${Math.round(tick / 1000)}k`}
              </text>
            </g>
          );
        })}
        <polygon points={areaPoints} fill={`url(#area-${compact ? 'small' : 'large'})`} />
        <polyline points={linePoints} className="chart-line" />
        {values.map((value, index) => {
          const [x, y] = points([0, value], max, (width / Math.max(values.length - 1, 1)) * index, height)
            .split(' ')
            .at(-1)!
            .split(',');
          return <circle key={`${value}-${index}`} cx={x} cy={y} r="4" className="chart-dot" />;
        })}
        {labels.map((label, index) => (
          <text
            key={label}
            x={(width / Math.max(labels.length - 1, 1)) * index}
            y={height - 10}
            textAnchor={index === 0 ? 'start' : index === labels.length - 1 ? 'end' : 'middle'}
            className="chart-label chart-label--date"
          >
            {label}
          </text>
        ))}
      </svg>
    </div>
  );
}

export function BarChart({ values, labels, max }: { values: number[]; labels: string[]; max: number }) {
  return (
    <div className="bar-chart" aria-label={`Bar chart with latest value ${values.at(-1)} hours`} role="img">
      {values.map((value, index) => (
        <div className="bar-chart__column" key={labels[index]}>
          <div className="bar-chart__track">
            <div className="bar-chart__bar" style={{ height: `${(value / max) * 100}%` }}>
              <span>{value}h</span>
            </div>
          </div>
          <p>{labels[index]}</p>
        </div>
      ))}
    </div>
  );
}
