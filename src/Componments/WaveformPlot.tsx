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
} from 'chart.js';

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale);

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

function calculateYAxis(data: number[]) {
    if (data.length === 0) {
        return { min: 0, max: 1 };
    }

    const minVal = Math.min(...data);
    const maxVal = Math.max(...data);
    const center = (minVal + maxVal) / 2;
    const range = (maxVal - minVal) || 1;
    const scaleFactor = 1.5;
    const newHalfRange = (range * scaleFactor) / 2;

    return {
        min: center - newHalfRange,
        max: center + newHalfRange,
    };
}

export default function WaveformPlot() {
    const [dataPoints, setDataPoints] = useState<number[]>([]);
    const [yAxis, setYAxis] = useState<{ min: number; max: number }>({ min: 0, max: 1 });
    const [triggerEnabled, setTriggerEnabled] = useState(false);
    const [triggeredData, setTriggeredData] = useState<number[]>([]);

    useEffect(() => {
        const interval = setInterval(async () => {
            try {
                const raw = await invoke<string>('read_serial_data');
                const nums = raw
                    .split(/[\s,]+/)
                    .map(x => parseFloat(x))
                    .filter(x => !isNaN(x));

                setDataPoints(prev => {
                    const newData = [...prev, ...nums].slice(-500);
                    if (triggerEnabled && !triggeredData.length) {
                        const triggerThreshold = 1.0; // Set your threshold for the trigger
                        for (let i = 0; i < newData.length; i++) {
                            if (newData[i] > triggerThreshold) {
                                setTriggeredData(newData.slice(i)); // Lock the waveform to this point
                                break;
                            }
                        }
                    }
                    return newData;
                });
            } catch (err) {
                console.error('Serial read error:', err);
            }
        }, 50);

        return () => clearInterval(interval);
    }, [triggerEnabled, triggeredData]);

    const bucketed = bucketSamples(triggeredData.length ? triggeredData : dataPoints, 5);
    const smoothed = movingAverage(bucketed, 10);

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
        },
    };

    function handleAutoScale() {
        const newAxis = calculateYAxis(smoothed);
        setYAxis(newAxis);
    }

    function toggleTrigger() {
        setTriggerEnabled(prev => !prev);
        setTriggeredData([]); // Clear the trigger state when toggling
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
                    }}
                >
                    {triggerEnabled ? 'Trigger On' : 'Trigger Off'}
                </button>
            </div>
            <Line data={chartData} options={options} />
        </div>
    );
}
