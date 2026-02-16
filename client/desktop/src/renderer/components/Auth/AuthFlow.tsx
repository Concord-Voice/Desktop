import React, { useState } from 'react';
import { ConnectionMode } from '../../types/auth';
import ConnectionSelector from './ConnectionSelector';
import ServerInput from './ServerInput';
import Register from './Register';
import Login from './Login';
import './AuthFlow.css';

type AuthStep = 'connection-select' | 'server-input' | 'hosted-register' | 'hosted-login' | 'self-hosted-auth';

const AuthFlow: React.FC = () => {
  const [step, setStep] = useState<AuthStep>('connection-select');
  const [selectedMode, setSelectedMode] = useState<ConnectionMode | null>(null);
  const [serverUrl, setServerUrl] = useState<string>('');

  const handleConnectionSelect = (mode: ConnectionMode) => {
    setSelectedMode(mode);

    if (mode === 'hosted') {
      setStep('hosted-register');
    } else if (mode === 'hosted-login') {
      setStep('hosted-login');
    } else {
      // Go to server input for self-hosted
      setStep('server-input');
    }
  };

  const handleServerConnect = (url: string) => {
    setServerUrl(url);
    setStep('self-hosted-auth');

    // TODO: Discover server capabilities and forward to server's auth
    console.log('Connecting to self-hosted server:', url);
  };

  const handleBack = () => {
    setStep('connection-select');
    setSelectedMode(null);
    setServerUrl('');
  };

  const handleRegistrationSuccess = (tokens: { accessToken: string; refreshToken: string }) => {
    console.log('Registration successful, tokens received');
    // TODO: Store tokens and navigate to main app
    // For now, just log
    console.log('Access token:', tokens.accessToken);
  };

  const handleLoginSuccess = (tokens: { accessToken: string; refreshToken: string }) => {
    console.log('Login successful, tokens received');
    // TODO: Store tokens and navigate to main app
    // For now, just log
    console.log('Access token:', tokens.accessToken);
  };

  const handleSwitchToLogin = () => {
    setStep('hosted-login');
  };

  const handleSwitchToRegister = () => {
    setStep('hosted-register');
  };

  return (
    <div className="auth-flow">
      {step === 'connection-select' && (
        <div key="connection-select" className="auth-screen">
          <ConnectionSelector onSelect={handleConnectionSelect} />
        </div>
      )}

      {step === 'server-input' && (
        <div key="server-input" className="auth-screen">
          <ServerInput onConnect={handleServerConnect} onBack={handleBack} />
        </div>
      )}

      {step === 'hosted-register' && (
        <div key="hosted-register" className="auth-screen">
          <Register
            onBack={handleBack}
            onSuccess={handleRegistrationSuccess}
            onSwitchToLogin={handleSwitchToLogin}
          />
        </div>
      )}

      {step === 'hosted-login' && (
        <div key="hosted-login" className="auth-screen">
          <Login
            onBack={handleBack}
            onSuccess={handleLoginSuccess}
            onSwitchToRegister={handleSwitchToRegister}
          />
        </div>
      )}

      {step === 'self-hosted-auth' && (
        <div className="auth-placeholder">
          <h2>Self-Hosted Auth</h2>
          <p>Connecting to: {serverUrl}</p>
          <p>Server's auth flow will be proxied here</p>
          <button onClick={handleBack}>← Back</button>
        </div>
      )}
    </div>
  );
};

export default AuthFlow;
