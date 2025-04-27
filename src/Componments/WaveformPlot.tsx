import { useEffect, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { invoke } from "@tauri-apps/api/core";
import {
    Chart as ChartJS,
    LineElement,
    PointElement,
    LinearScale,
    CategoryScale,
    ChartOptions,
    ChartData,
    Tooltip,
    Title
} from 'chart.js';

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Title);


let bucketSize = 1;
let smoothingSize = 1;
let refreshRate = 20;



function movingAverage(data: number[], windowSize: number): number[] {
    if (windowSize <= 1) return data;

    const result: number[] = [];
    let sum = 0;
    let queue: number[] = [];

    for (let i = 0; i < data.length; i++) {
        queue.push(data[i]);
        sum += data[i];

        if (queue.length > windowSize) {
            sum -= queue.shift()!;
        }

        result.push(sum / queue.length);
    }

    return result;
}

function bucketSamples(data: number[], bucketSize: number): number[] {
    const result: number[] = [];

    for (let i = 0; i < data.length; i += bucketSize) {
        const bucket = data.slice(i, i + bucketSize);
        const avg = bucket.reduce((sum, val) => sum + val, 0) / bucket.length;
        result.push(avg);
    }

    return result;
}


export default function WaveformPlot() {
    const [dataPoints, setDataPoints] = useState<number[]>([]);
    const [yAxis, setYAxis] = useState<{ min: number; max: number }>({ min: 0, max: 1 });
    const [triggerEnabled, setTriggerEnabled] = useState(false);
    const [triggeredData, setTriggeredData] = useState<number[]>([]);

    const [manualZoom, setManualZoom] = useState(200);
    const [xAxisRange, setXAxisRange] = useState({ min: 0, max: manualZoom });


    useEffect(() => {
        const interval = setInterval(async () => {
            try {
                const raw = await invoke<string>('read_serial_data');
                const nums = raw
                    .split(/[\s,]+/)
                    .map(x => parseFloat(x))
                    .filter(x => !isNaN(x));

                setDataPoints(prev => {
                    const newData = [...prev, ...nums].slice(-manualZoom * bucketSize + 1);
                    if (triggerEnabled && !triggeredData.length) {
                        const triggerThreshold = 1.0;
                        for (let i = 0; i < newData.length; i++) {
                            if (newData[i] > triggerThreshold) {
                                setTriggeredData(newData.slice(i));
                                break;
                            }
                        }
                    }
                    return newData;
                });
            } catch (err) {
                console.error('Serial read error:', err);
            }
        }, refreshRate);

        return () => clearInterval(interval);
    }, [triggerEnabled, triggeredData, manualZoom]);

    const bucketed = bucketSamples(triggeredData.length ? triggeredData : dataPoints, bucketSize);
    const smoothed = movingAverage(bucketed, smoothingSize);

    const chartData: ChartData<'line'> = {
        labels: smoothed.map((_, i) => i.toString()),
        datasets: [
            {
                label: 'Signal',
                data: smoothed,
                borderColor: 'cyan',
                borderWidth: 2,
                tension: 0.2,
                fill: false,
                pointRadius: 0,
            },
        ],
    };

    const options: ChartOptions<'line'> = {
        responsive: true,
        animation: false,
        scales: {
            y: {
                min: yAxis.min,
                max: yAxis.max,
            },
            x: {
                type: 'linear',
                min: xAxisRange.min,
                max: xAxisRange.max,
            },
        },
    };

    function handleAutoScale() {
        if (smoothed.length >= 200) {

            const peaks: number[] = [];
            const threshold = 0.1; // Minimum difference between a peak and its neighbors

            // Compute the first derivative (differences between consecutive values)
            const derivatives = smoothed.map((_value, index, array) => {
                if (index === 0 || index === array.length - 1) return 0; // No derivative at the edges
                return array[index + 1] - array[index - 1];
            });

            // Find peaks based on where the derivative changes sign
            for (let i = 1; i < smoothed.length - 1; i++) {
                // Peak detection: look for a change in the sign of the derivative (slope)
                if (derivatives[i] > threshold && smoothed[i] > smoothed[i - 1] && smoothed[i] > smoothed[i + 1]) {
                    peaks.push(i); // Local maximum (peak)
                }
            }

            // If there are enough peaks, calculate the period (distance between two consecutive peaks)
            if (peaks.length >= 2) {
                const period = peaks[1] - peaks[0]; // Distance between the first two peaks
                const newZoom = period * 2; // Set the zoom level to the detected period (show 1 full cycle)
                setManualZoom(newZoom);
                setXAxisRange({
                    min: 0,
                    max: newZoom,
                });
            }
        }

        // Also adjust the Y-axis as before to show a full range
        const peakToPeak = Math.max(...smoothed) - Math.min(...smoothed);
        const padding = peakToPeak * 0.3;

        const newYAxis = {
            min: Math.min(...smoothed) - padding,
            max: Math.max(...smoothed) + padding,
        };

        setYAxis(newYAxis); // Update Y-axis to full range with padding
    }


    function toggleTrigger() {
        setTriggerEnabled(prev => !prev);
        setTriggeredData([]); // Clear the trigger state when toggling
    }

    function handleManualZoomChange(e: React.ChangeEvent<HTMLInputElement>) {
        const newZoom = parseInt(e.target.value, 10);
        if (isNaN(newZoom)) return;
        setManualZoom(newZoom);
        setXAxisRange({
            min: 0,
            max: newZoom,
        });
    }

    function handleLog() {
        console.log("log");
    }

    return (
        <div style={{ width: '90%', margin: 'auto', paddingTop: 20 }}>
            <h2 style={{ textAlign: 'center', color: '#fff' }}>Oscilloscope</h2>
            <div style={{ textAlign: 'center', marginBottom: '10px' }}>
                <button
                    onClick={handleAutoScale}
                    style={{
                        backgroundColor: 'cyan',
                        color: 'black',
                        border: 'none',
                        borderRadius: '5px',
                        padding: '8px 16px',
                        fontSize: '16px',
                        cursor: 'pointer',
                        marginRight: '10px',
                    }}
                >
                    Auto Scale
                </button>
                <button
                    onClick={toggleTrigger}
                    style={{
                        backgroundColor: triggerEnabled ? 'green' : 'red',
                        color: 'white',
                        border: 'none',
                        borderRadius: '5px',
                        padding: '8px 16px',
                        fontSize: '16px',
                        cursor: 'pointer',
                        marginRight: '10px',
                    }}
                >
                    {triggerEnabled ? 'Trigger On' : 'Trigger Off'}
                </button>

                <button
                    onClick={handleLog}
                    style={{
                        backgroundColor: "lightyellow",
                        color: 'black',
                        border: 'none',
                        borderRadius: '5px',
                        padding: '8px 16px',
                        fontSize: '16px',
                        cursor: 'pointer',
                    }}
                >
                    Log Export
                </button>


            </div>
            <div style={{ textAlign: 'center', marginBottom: '10px' }}>

                <input
                    type="number"
                    value={manualZoom}
                    onChange={handleManualZoomChange}
                    style={{
                        padding: '8px',
                        fontSize: '16px',
                        borderRadius: '5px',
                        marginLeft: '10px',
                    }}
                    min="1"
                    max="10000000"
                />
                <span style={{ marginLeft: '10px', fontSize: '16px' }}>Samples</span>
            </div>
            <Line data={chartData} options={options} />
        </div>
    );
}