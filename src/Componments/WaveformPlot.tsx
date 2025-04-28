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


let bucketSize = 2;
let smoothingSize = 2;
let refreshRate = 50;





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
    const [isRecording, setIsRecording] = useState(false);

    async function handleLogToggle() {
        try {
            const newRecordingState = !isRecording;
            await invoke("toggle_log", { enable: newRecordingState });
            setIsRecording(newRecordingState);
        } catch (error) {
            console.error("Failed to toggle logging:", error);
        }
    }


    useEffect(() => {
        const interval = setInterval(async () => {
            try {
                const rawData = await invoke<string[]>('get_serial_data');

                const nums = rawData
                    .flatMap(chunk =>
                        chunk
                            .split(/[\s,]+/)
                            .map(x => parseFloat(x))
                            .filter(x => !isNaN(x))
                    );

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
    }, [triggerEnabled, triggeredData.length, manualZoom, bucketSize, refreshRate]);


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
        if (smoothed.length >= manualZoom / 2) {

            const peaks: number[] = [];
            const threshold = 0.05;

            const derivatives = smoothed.map((_value, index, array) => {
                if (index === 0 || index === array.length - 1) return 0;
                return array[index + 1] - array[index - 1];
            });

            for (let i = 1; i < smoothed.length - 1; i++) {
                if (derivatives[i] > threshold && smoothed[i] > smoothed[i - 1] && smoothed[i] > smoothed[i + 1]) {
                    peaks.push(i);
                }
            }

            if (peaks.length >= 4) {
                const period = peaks[1] - peaks[0];
                const newZoom = period * 2;
                setManualZoom(newZoom);
                setXAxisRange({
                    min: 0,
                    max: newZoom,
                });
            }
        }

        const peakToPeak = Math.max(...smoothed) - Math.min(...smoothed);
        const padding = peakToPeak * 0.3;

        const newYAxis = {
            min: Math.min(...smoothed) - padding,
            max: Math.max(...smoothed) + padding,
        };

        setYAxis(newYAxis);
    }


    function toggleTrigger() {
        setTriggerEnabled(prev => !prev);
        setTriggeredData([]);
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


    return (
        <div style={{ width: '90%', margin: 'auto', paddingTop: 0, minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>

            <h2 style={{ textAlign: 'center', color: '#fff', marginTop: 0  }}>Oscilloscope</h2>
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
            <div style={{ textAlign: 'center', marginBottom: '10px' }}>
                <label style={{ marginRight: '5px' }}>Y Min:</label>
                <input
                    type="number"
                    value={yAxis.min}
                    onChange={(e) => {
                        const min = parseFloat(e.target.value);
                        if (!isNaN(min)) {
                            setYAxis(prev => ({ ...prev, min }));
                        }
                    }}
                    style={{
                        padding: '8px',
                        fontSize: '16px',
                        borderRadius: '5px',
                        marginRight: '10px',
                        width: '100px',
                    }}
                />
                <label style={{ marginRight: '5px' }}>Y Max:</label>
                <input
                    type="number"
                    value={yAxis.max}
                    onChange={(e) => {
                        const max = parseFloat(e.target.value);
                        if (!isNaN(max)) {
                            setYAxis(prev => ({ ...prev, max }));
                        }
                    }}
                    style={{
                        padding: '8px',
                        fontSize: '16px',
                        borderRadius: '5px',
                        width: '100px',
                    }}
                />
            </div>
            <div style={{ textAlign: 'center', marginBottom: '10px' }}>
                <button
                    onClick={() => setYAxis({ min: 0, max: 1 })}
                    style={{
                        backgroundColor: 'lightblue',
                        color: 'black',
                        border: 'none',
                        borderRadius: '5px',
                        padding: '8px 16px 8px 16px',
                        fontSize: '16px',
                        cursor: 'pointer',
                        width: '150px',
                    }}
                >
                    Reset Y Axis
                </button>
                <button
                    onClick={handleLogToggle}
                    style={{
                        backgroundColor: isRecording ? 'orange' : 'lightyellow',
                        color: 'black',
                        border: 'none',
                        borderRadius: '5px',
                        padding: '8px 16px 8px 16px',
                        fontSize: '16px',
                        cursor: 'pointer',
                        marginLeft: '10px',
                        width: '150px',
                    }}
                >
                    {isRecording ? 'Stop Log' : 'Start Log'}
                </button>
            </div>


        </div>
    );
}