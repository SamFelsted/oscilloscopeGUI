// Web Worker for waveform data processing
type ChannelData = {
    ch1: number[];
    ch2: number[];
    ch3: number[];
    ch4: number[];
};

type WorkerMessage = {
    type: 'process';
    data: string[];
    activeChannels: boolean[];
    bucketSize: number;
    smoothingSize: number;
    viewport: { start: number; end: number };
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

function decimateData(data: number[], viewport: { start: number; end: number }, maxPoints: number = 1000): number[] {
    const visibleData = data.slice(viewport.start, viewport.end);
    if (visibleData.length <= maxPoints) return visibleData;

    const step = Math.ceil(visibleData.length / maxPoints);
    const result: number[] = [];
    for (let i = 0; i < visibleData.length; i += step) {
        result.push(visibleData[i]);
    }
    return result;
}

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
    if (e.data.type === 'process') {
        const { data, activeChannels, bucketSize, smoothingSize, viewport } = e.data;
        const parsed = parseChannels(data);
        
        const processedData: ChannelData = {
            ch1: [],
            ch2: [],
            ch3: [],
            ch4: []
        };

        // Only process active channels
        for (let i = 0; i < 4; i++) {
            if (activeChannels[i]) {
                const channelKey = `ch${i + 1}` as keyof ChannelData;
                const bucketed = bucketSamples(parsed[channelKey], bucketSize);
                const smoothed = movingAverage(bucketed, smoothingSize);
                processedData[channelKey] = decimateData(smoothed, viewport);
            }
        }

        self.postMessage(processedData);
    }
}; 