import { useState, useEffect } from 'react';
import { Line } from 'react-chartjs-2';
import { invoke } from "@tauri-apps/api/core";
import { Chart as ChartJS, LineElement, PointElement, LinearScale, CategoryScale, ChartOptions, ChartData, Tooltip, Title } from 'chart.js';
import SettingsModal from './SettingsModal';

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Title);

function movingAverage(data: number[], windowSize: number): number[] {
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

export default function WaveformPlot() {
    const [dataPoints, setDataPoints] = useState<number[]>([]);
    const [yAxis, setYAxis] = useState<{ min: number; max: number }>({ min: 0, max: 1 });
    const [manualZoom, setManualZoom] = useState(200);
    const [xAxisRange, setXAxisRange] = useState({ min: 0, max: manualZoom });
    const [samplingRate, setSamplingRate] = useState<number>(1000); // Default sampling rate
    const [showSettings, setShowSettings] = useState<boolean>(false); // State for showing settings modal

    const smoothingSize = 3;

    useEffect(() => {
        const interval = setInterval(async () => {
            try {
                const raw = await invoke<string>('read_serial_data');
                const nums = raw
                    .split(/[\s,]+/)
                    .map(x => parseFloat(x))
                    .filter(x => !isNaN(x));

                setDataPoints(prev => {
                    return [...prev, ...nums].slice(-manualZoom);
                });
            } catch (err) {
                console.error('Serial read error:', err);
            }
        }, 50);

        return () => clearInterval(interval);
    }, [manualZoom]);

    const smoothed = movingAverage(dataPoints, smoothingSize);

    const chartData: ChartData<'line'> = {
        labels: smoothed.map((_, i) => (i / samplingRate).toFixed(3)), // Convert sample index to seconds
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

    // @ts-ignore
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
                min: xAxisRange.min / samplingRate,
                max: xAxisRange.max / samplingRate,
                ticks: {
                    callback: function(tickValue: string | number) {
                        // Convert the tickValue to number (if it's a string) and format it
                        return Number(tickValue).toFixed(3); // Format X-axis ticks in seconds
                    },
                },

            },
        },
    };

    function handleAutoScale() {
        if (smoothed.length < 200) return;

        const peaks: number[] = [];
        const threshold = 0.1;
        const derivatives = smoothed.map((value, index, array) => {
            if (index === 0 || index === array.length - 1) return 0;
            return array[index + 1] - array[index - 1];
        });

        for (let i = 1; i < smoothed.length - 1; i++) {
            if (derivatives[i] > threshold && smoothed[i] > smoothed[i - 1] && smoothed[i] > smoothed[i + 1]) {
                peaks.push(i);
            }
        }

        if (peaks.length >= 2) {
            const period = peaks[1] - peaks[0];
            setManualZoom(period * 2);
            setXAxisRange({
                min: 0,
                max: period * 2,
            });
        }

        const peakToPeak = Math.max(...smoothed) - Math.min(...smoothed);
        const padding = peakToPeak * 0.2;
        setYAxis({
            min: Math.min(...smoothed) - padding,
            max: Math.max(...smoothed) + padding,
        });
    }

    return (
        <div style={{ width: '90%', margin: 'auto', paddingTop: 20 }}>
            <h2 style={{ textAlign: 'center', color: '#fff' }}>Oscilloscope</h2>
            <div style={{ textAlign: 'center', marginBottom: '10px' }}>
                <button
                    onClick={() => setShowSettings(true)}
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
                    Settings
                </button>

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
            </div>

            {showSettings && (
                <SettingsModal
                    onClose={() => setShowSettings(false)}
                    onSave={(newSamplingRate) => {
                        setSamplingRate(newSamplingRate);
                        setShowSettings(false);
                    }}
                />
            )}

            <Line data={chartData} options={options} />
        </div>
    );
}
