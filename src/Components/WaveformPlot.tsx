import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Line } from 'react-chartjs-2';
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

const DEFAULT_BUFFER_SIZE = 1000;
const REFRESH_RATE = 50; // milliseconds
const DEFAULT_SMOOTHING = 3; // Reduced smoothing window

interface ChannelData {
    ch1: number[];
    ch2: number[];
    ch3: number[];
    ch4: number[];
}

interface TriggeredData {
    ch1: number[];
    ch2: number[];
    ch3: number[];
    ch4: number[];
}

function movingAverage(data: number[], windowSize: number): number[] {
    if (windowSize <= 1) return data;
    const result: number[] = [];
    const halfWindow = Math.floor(windowSize / 2);
    
    // Pad the data at the ends
    const paddedData = [
        ...Array(halfWindow).fill(data[0]),
        ...data,
        ...Array(halfWindow).fill(data[data.length - 1])
    ];
    
    for (let i = 0; i < data.length; i++) {
        let sum = 0;
        for (let j = 0; j < windowSize; j++) {
            sum += paddedData[i + j];
        }
        result.push(sum / windowSize);
    }
    
    return result;
}

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

const WaveformPlot: React.FC = () => {
    const [channelData, setChannelData] = useState<ChannelData>({ ch1: [], ch2: [], ch3: [], ch4: [] });
    const [triggeredData, setTriggeredData] = useState<TriggeredData>({ ch1: [], ch2: [], ch3: [], ch4: [] });
    const [triggerEnabled, setTriggerEnabled] = useState(false);
    const [triggerChannel, setTriggerChannel] = useState(1);
    const [triggerLevel, setTriggerLevel] = useState(0);
    const [triggerRisingEdge, setTriggerRisingEdge] = useState(true);
    const [smoothingSize, setSmoothingSize] = useState(DEFAULT_SMOOTHING);
    const [activeChannels, setActiveChannels] = useState<boolean[]>([true, true, false, false]);
    const [yAxis, setYAxis] = useState<{ min: number; max: number }>({ min: -10, max: 10 });
    const [xAxisRange, setXAxisRange] = useState({ min: 0, max: 1000 });

    useEffect(() => {
        const interval = setInterval(async () => {
            try {
                const rawData = await invoke<string[]>('get_serial_data');
                const parsed = parseChannels(rawData);

                setChannelData(prev => {
                    // If trigger is enabled and we have triggered data, don't update
                    if (triggerEnabled && triggeredData.ch1.length > 0) {
                        return prev;
                    }

                    const newData: ChannelData = {
                        ch1: [...prev.ch1, ...parsed.ch1].slice(-DEFAULT_BUFFER_SIZE),
                        ch2: [...prev.ch2, ...parsed.ch2].slice(-DEFAULT_BUFFER_SIZE),
                        ch3: [...prev.ch3, ...parsed.ch3].slice(-DEFAULT_BUFFER_SIZE),
                        ch4: [...prev.ch4, ...parsed.ch4].slice(-DEFAULT_BUFFER_SIZE)
                    };

                    // Check for trigger condition
                    if (triggerEnabled && !triggeredData.ch1.length) {
                        const triggerChannelKey = `ch${triggerChannel + 1}` as keyof ChannelData;
                        const triggerData = newData[triggerChannelKey];
                        
                        for (let i = 0; i < triggerData.length; i++) {
                            const voltage = triggerData[i];
                            if ((triggerRisingEdge && voltage > triggerLevel) ||
                                (!triggerRisingEdge && voltage < triggerLevel)) {
                                // Found trigger point, capture data from this point
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
    }, [triggerEnabled, triggeredData.ch1.length, triggerChannel, triggerLevel, triggerRisingEdge]);

    // Reset trigger when trigger settings change
    useEffect(() => {
        if (triggerEnabled) {
            setTriggeredData({ ch1: [], ch2: [], ch3: [], ch4: [] });
        }
    }, [triggerChannel, triggerLevel, triggerRisingEdge]);

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
            // Clear triggered data when disabling trigger
            setTriggeredData({ ch1: [], ch2: [], ch3: [], ch4: [] });
        } catch (error) {
            console.error("Failed to configure trigger:", error);
        }
    }

    const processChannelData = (data: number[]) => {
        // Only use moving average for smoothing
        return movingAverage(data, smoothingSize);
    };

    const displayData = triggeredData.ch1.length > 0 ? triggeredData : channelData;
    const processedData = {
        ch1: processChannelData(displayData.ch1),
        ch2: processChannelData(displayData.ch2),
        ch3: processChannelData(displayData.ch3),
        ch4: processChannelData(displayData.ch4)
    };

    const chartData: ChartData<'line'> = {
        labels: processedData.ch1.map((_, i) => i.toString()),
        datasets: [0, 1, 2, 3].map((index) => ({
            label: `Channel ${index + 1}`,
            data: processedData[`ch${index + 1}` as keyof ChannelData],
            borderColor: ['cyan', 'red', 'green', 'yellow'][index],
            borderWidth: 2,
            tension: 0.1, // Reduced tension for sharper edges
            fill: false,
            pointRadius: 0, // Hide points for cleaner display
            hidden: false
        }))
    };

    const options: ChartOptions<'line'> = {
        responsive: true,
        animation: false,
        scales: {
            y: {
                min: 0,
                max: 5,
                title: {
                    display: true,
                    text: 'Voltage (V)'
                }
            },
            x: {
                type: 'linear',
                min: 0,
                max: processedData.ch1.length,
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

    return (
        <div style={{ width: '90%', margin: 'auto', paddingTop: 0, minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ textAlign: 'center', marginBottom: '10px' }}>
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
            </div>

            <Line data={chartData} options={options} />
        </div>
    );
};

export default WaveformPlot; 