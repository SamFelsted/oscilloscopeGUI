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
    Title,
    Legend
} from 'chart.js';

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Title, Legend);

// Configuration constants
const CHANNEL_COLORS = ['cyan', 'red', 'green', 'yellow'];
const REFRESH_RATE = 50; // ms
const DEFAULT_BUFFER_SIZE = 1000;
const DEFAULT_SMOOTHING = 1;
const DEFAULT_BUCKET_SIZE = 1;

type ChannelData = {
    ch1: number[];
    ch2: number[];
    ch3: number[];
    ch4: number[];
};

function parseChannels(rawData: string[]): ChannelData {
    const channels: ChannelData = {
        ch1: [],
        ch2: [],
        ch3: [],
        ch4: []
    };

    for (const line of rawData) {
        const match = line.match(/Ch(\d+):\s*([-\d.]+)\s*V/);
        if (match) {
            const [, channel, value] = match;
            const channelNum = parseInt(channel);
            const voltage = parseFloat(value);
            
            if (!isNaN(voltage) && channelNum >= 1 && channelNum <= 4) {
                const channelKey = `ch${channelNum}` as keyof ChannelData;
                channels[channelKey].push(voltage);
            }
        }
    }

    return channels;
}

function movingAverage(data: number[], windowSize: number): number[] {
    if (windowSize <= 1) return data;
    const result: number[] = [];
    let sum = 0;
    let queue: number[] = [];

    for (const value of data) {
        queue.push(value);
        sum += value;
        if (queue.length > windowSize) {
            sum -= queue.shift()!;
        }
        result.push(sum / queue.length);
    }

    return result;
}

function bucketSamples(data: number[], bucketSize: number): number[] {
    if (bucketSize <= 1) return data;
    const result: number[] = [];

    for (let i = 0; i < data.length; i += bucketSize) {
        const bucket = data.slice(i, i + bucketSize);
        const avg = bucket.reduce((sum, val) => sum + val, 0) / bucket.length;
        result.push(avg);
    }

    return result;
}

export default function WaveformPlot() {
    // State for each channel
    const [channelData, setChannelData] = useState<ChannelData>({
        ch1: [],
        ch2: [],
        ch3: [],
        ch4: []
    });
    const [activeChannels, setActiveChannels] = useState<boolean[]>([true, false, false, false]);
    const [yAxis, setYAxis] = useState<{ min: number; max: number }>({ min: -10, max: 10 });
    const [triggerEnabled, setTriggerEnabled] = useState(false);
    const [triggerLevel, setTriggerLevel] = useState(0.0);
    const [triggerChannel, setTriggerChannel] = useState(0);
    const [triggerRisingEdge, setTriggerRisingEdge] = useState(true);
    const [triggeredData, setTriggeredData] = useState<ChannelData>({
        ch1: [], ch2: [], ch3: [], ch4: []
    });
    const [manualZoom, setManualZoom] = useState(200);
    const [xAxisRange, setXAxisRange] = useState({ min: 0, max: manualZoom });
    const [isRecording, setIsRecording] = useState(false);
    const [smoothingSize, setSmoothingSize] = useState(DEFAULT_SMOOTHING);
    const [bucketSize, setBucketSize] = useState(DEFAULT_BUCKET_SIZE);

    async function handleLogToggle() {
        try {
            const newRecordingState = !isRecording;
            await invoke("toggle_log", { enable: newRecordingState });
            setIsRecording(newRecordingState);
        } catch (error) {
            console.error("Failed to toggle logging:", error);
        }
    }

    async function handleTriggerToggle() {
        const newTriggerState = !triggerEnabled;
        try {
            await invoke("configure_trigger", {
                config: {
                    enabled: newTriggerState,
                    channel: triggerChannel,
                    level: triggerLevel,
                    rising_edge: triggerRisingEdge
                }
            });
            setTriggerEnabled(newTriggerState);
            if (!newTriggerState) {
                // Clear triggered data when disabling trigger
                setTriggeredData({ ch1: [], ch2: [], ch3: [], ch4: [] });
            }
        } catch (error) {
            console.error("Failed to configure trigger:", error);
        }
    }

    useEffect(() => {
        const interval = setInterval(async () => {
            try {
                const rawData = await invoke<string[]>('get_serial_data');
                const parsed = parseChannels(rawData);

                setChannelData(prev => {
                    const newData: ChannelData = {
                        ch1: [...prev.ch1, ...parsed.ch1].slice(-DEFAULT_BUFFER_SIZE),
                        ch2: [...prev.ch2, ...parsed.ch2].slice(-DEFAULT_BUFFER_SIZE),
                        ch3: [...prev.ch3, ...parsed.ch3].slice(-DEFAULT_BUFFER_SIZE),
                        ch4: [...prev.ch4, ...parsed.ch4].slice(-DEFAULT_BUFFER_SIZE)
                    };

                    if (triggerEnabled && !triggeredData.ch1.length) {
                        const triggerThreshold = 1.0;
                        for (let i = 0; i < newData.ch1.length; i++) {
                            if (newData.ch1[i] > triggerThreshold) {
                                setTriggeredData({
                                    ch1: newData.ch1.slice(i),
                                    ch2: newData.ch2.slice(i),
                                    ch3: newData.ch3.slice(i),
                                    ch4: newData.ch4.slice(i)
                                });
                                break;
                            }
                        }
                    }

                    return newData;
                });
            } catch (err) {
                console.error('Serial read error:', err);
            }
        }, REFRESH_RATE);

        return () => clearInterval(interval);
    }, [triggerEnabled, triggeredData.ch1.length]);

    const processChannelData = (data: number[]) => {
        const bucketed = bucketSamples(data, bucketSize);
        return movingAverage(bucketed, smoothingSize);
    };

    const displayData = triggeredData.ch1.length ? triggeredData : channelData;
    const processedData = {
        ch1: processChannelData(displayData.ch1),
        ch2: processChannelData(displayData.ch2),
        ch3: processChannelData(displayData.ch3),
        ch4: processChannelData(displayData.ch4)
    };

    const chartData: ChartData<'line'> = {
        labels: processedData.ch1.map((_, i) => i.toString()),
        datasets: activeChannels.map((active, index) => ({
            label: `Channel ${index + 1}`,
            data: processedData[`ch${index + 1}` as keyof ChannelData],
            borderColor: CHANNEL_COLORS[index],
            borderWidth: 2,
            tension: 0.2,
            fill: false,
            pointRadius: 0,
            hidden: !active
        }))
    };

    const options: ChartOptions<'line'> = {
        responsive: true,
        animation: false,
        scales: {
            y: {
                min: yAxis.min,
                max: yAxis.max,
                title: {
                    display: true,
                    text: 'Voltage (V)'
                }
            },
            x: {
                type: 'linear',
                min: xAxisRange.min,
                max: xAxisRange.max,
                title: {
                    display: true,
                    text: 'Samples'
                }
            }
        },
        plugins: {
            legend: {
                position: 'top' as const,
                labels: {
                    color: 'white'
                }
            }
        }
    };

    function handleAutoScale() {
        const allValues = Object.values(processedData).flat();
        if (allValues.length > 0) {
            const peakToPeak = Math.max(...allValues) - Math.min(...allValues);
            const padding = peakToPeak * 0.3;
            setYAxis({
                min: Math.min(...allValues) - padding,
                max: Math.max(...allValues) + padding
            });
        }
    }

    function toggleChannel(index: number) {
        setActiveChannels(prev => {
            const newChannels = [...prev];
            newChannels[index] = !newChannels[index];
            return newChannels;
        });
    }

    return (
        <div style={{ width: '90%', margin: 'auto', paddingTop: 0, minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
            <h2 style={{ textAlign: 'center', color: '#fff', marginTop: 0 }}>Oscilloscope</h2>
            
            <div style={{ textAlign: 'center', marginBottom: '10px' }}>
                {CHANNEL_COLORS.map((color, index) => (
                    <button
                        key={index}
                        onClick={() => toggleChannel(index)}
                        style={{
                            backgroundColor: activeChannels[index] ? color : '#444',
                            color: 'white',
                            border: 'none',
                            borderRadius: '5px',
                            padding: '8px 16px',
                            fontSize: '16px',
                            cursor: 'pointer',
                            marginRight: '10px',
                        }}
                    >
                        Ch{index + 1}
                    </button>
                ))}
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
                    onClick={handleTriggerToggle}
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
                {triggerEnabled && (
                    <div style={{ display: 'inline-block', marginLeft: '10px' }}>
                        <select
                            value={triggerChannel}
                            onChange={(e) => {
                                const channel = parseInt(e.target.value);
                                setTriggerChannel(channel);
                                invoke("configure_trigger", {
                                    config: {
                                        enabled: triggerEnabled,
                                        channel,
                                        level: triggerLevel,
                                        rising_edge: triggerRisingEdge
                                    }
                                });
                            }}
                            style={{
                                padding: '8px',
                                fontSize: '16px',
                                borderRadius: '5px',
                                marginRight: '10px'
                            }}
                        >
                            <option value={0}>Ch1</option>
                            <option value={1}>Ch2</option>
                            <option value={2}>Ch3</option>
                            <option value={3}>Ch4</option>
                        </select>
                        <input
                            type="number"
                            value={triggerLevel}
                            onChange={(e) => {
                                const level = parseFloat(e.target.value);
                                if (!isNaN(level)) {
                                    setTriggerLevel(level);
                                    invoke("configure_trigger", {
                                        config: {
                                            enabled: triggerEnabled,
                                            channel: triggerChannel,
                                            level,
                                            rising_edge: triggerRisingEdge
                                        }
                                    });
                                }
                            }}
                            style={{
                                padding: '8px',
                                fontSize: '16px',
                                borderRadius: '5px',
                                width: '100px',
                                marginRight: '10px'
                            }}
                            step="0.1"
                        />
                        <select
                            value={triggerRisingEdge ? 'rising' : 'falling'}
                            onChange={(e) => {
                                const rising = e.target.value === 'rising';
                                setTriggerRisingEdge(rising);
                                invoke("configure_trigger", {
                                    config: {
                                        enabled: triggerEnabled,
                                        channel: triggerChannel,
                                        level: triggerLevel,
                                        rising_edge: rising
                                    }
                                });
                            }}
                            style={{
                                padding: '8px',
                                fontSize: '16px',
                                borderRadius: '5px'
                            }}
                        >
                            <option value="rising">Rising Edge</option>
                            <option value="falling">Falling Edge</option>
                        </select>
                    </div>
                )}
            </div>

            <div style={{ textAlign: 'center', marginBottom: '10px' }}>
                <label style={{ marginRight: '10px' }}>Time Base:</label>
                <input
                    type="number"
                    value={manualZoom}
                    onChange={(e) => {
                        const value = parseInt(e.target.value);
                        if (!isNaN(value) && value > 0) {
                            setManualZoom(value);
                            setXAxisRange({ min: 0, max: value });
                        }
                    }}
                    style={{
                        padding: '8px',
                        fontSize: '16px',
                        borderRadius: '5px',
                        width: '100px',
                        marginRight: '10px'
                    }}
                    min="1"
                />
                <label style={{ marginRight: '10px' }}>Smoothing:</label>
                <input
                    type="number"
                    value={smoothingSize}
                    onChange={(e) => {
                        const value = parseInt(e.target.value);
                        if (!isNaN(value) && value >= 1) {
                            setSmoothingSize(value);
                        }
                    }}
                    style={{
                        padding: '8px',
                        fontSize: '16px',
                        borderRadius: '5px',
                        width: '80px',
                        marginRight: '10px'
                    }}
                    min="1"
                />
                <label style={{ marginRight: '10px' }}>Bucket Size:</label>
                <input
                    type="number"
                    value={bucketSize}
                    onChange={(e) => {
                        const value = parseInt(e.target.value);
                        if (!isNaN(value) && value >= 1) {
                            setBucketSize(value);
                        }
                    }}
                    style={{
                        padding: '8px',
                        fontSize: '16px',
                        borderRadius: '5px',
                        width: '80px'
                    }}
                    min="1"
                />
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
                        marginRight: '10px'
                    }}
                />
                <button
                    onClick={() => setYAxis({ min: -10, max: 10 })}
                    style={{
                        backgroundColor: 'lightblue',
                        color: 'black',
                        border: 'none',
                        borderRadius: '5px',
                        padding: '8px 16px',
                        fontSize: '16px',
                        cursor: 'pointer',
                        marginRight: '10px',
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
                        padding: '8px 16px',
                        fontSize: '16px',
                        cursor: 'pointer',
                    }}
                >
                    {isRecording ? 'Stop Log' : 'Start Log'}
                </button>
            </div>
        </div>
    );
}