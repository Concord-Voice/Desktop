import React, { useState } from 'react';
import { ConnectionMode } from '../../types/auth';
import ConnectionSelector from './ConnectionSelector';
import ServerInput from './ServerInput';
import Register from './Register';
import Login from './Login';

type AuthStep = 'connection-select' | 'server-input' | 'hosted-register' | 'hosted-login' | 'self-hosted-auth';

const AuthFlow: React.FC = () => {
  const [step, setStep] = useState<AuthStep>('connection-select');
  const [selectedMode, setSelectedMode] = useState<ConnectionMode | null>(null);
  const [serverUrl, setServerUrl] = useState<string>('');

  const handleConnectionSelect = (mode: ConnectionMode) => {
    setSelectedMode(mode);

    if (mode === 'hosted') {
      // For now, go to hosted register (we'll add login option later)
      setStep('hosted-register');
    } else {
      // Go to server input
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
        <ConnectionSelector onSelect={handleConnectionSelect} />
      )}

      {step === 'server-input' && (
        <ServerInput onConnect={handleServerConnect} onBack={handleBack} />
      )}

      {step === 'hosted-register' && (
        <Register
          onBack={handleBack}
          onSuccess={handleRegistrationSuccess}
          onSwitchToLogin={handleSwitchToLogin}
        />
      )}

      {step === 'hosted-login' && (
        <Login
          onBack={handleBack}
          onSuccess={handleLoginSuccess}
          onSwitchToRegister={handleSwitchToRegister}
        />
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
