import { useState } from 'react';

export default function SettingsModal({ onClose, onSave }: { onClose: () => void, onSave: (samplingRate: number) => void }) {
    const [samplingRate, setSamplingRate] = useState<number>(200000);

    const handleSave = () => {
        onSave(samplingRate);
        onClose();
    };

    return (
        <div
            style={{
                position: 'absolute',  // Corrected to a valid CSS value for position
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                backgroundColor: 'rgba(0, 0, 0, 0.5)', // Example background color
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
        }}
        >
            <div
                style={{
                    backgroundColor: 'rgba(0, 0, 0, 0.5)',
                    padding: '10px',
                    borderRadius: '5px',
                    minWidth: '200px',
                    textAlign: 'center',  // Corrected to a valid CSS value
                }}
            >
                <h2>Settings</h2>
                <label>
                    Sampling Rate (Hz):
                    <input
                        type="number"
                        value={samplingRate}
                        onChange={(e) => setSamplingRate(Number(e.target.value))}
                        min="1"
                        style={{ marginLeft: 10 }}
                    />
                </label>
                <div style={modalStyles.buttonContainer}>
                    <button onClick={handleSave} style={modalStyles.button}>Save</button>
                    <button onClick={onClose} style={modalStyles.button}>Close</button>
                </div>
            </div>
        </div>
    );
}

const modalStyles = {
    overlay: {
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
    },
    container: {
        backgroundColor: '#fff',
        padding: '20px',
        borderRadius: '8px',
        minWidth: '300px',
        textAlign: 'center',
    },
    buttonContainer: {
        marginTop: '10px',
    },
    button: {
        backgroundColor: '#4CAF50',
        color: 'white',
        border: 'none',
        padding: '10px 20px',
        margin: '0 10px',
        cursor: 'pointer',
        borderRadius: '5px',
    },
};
