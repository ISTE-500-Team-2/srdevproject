import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api, errorMessage } from '../lib/api';
export function ConfirmEmailPage() {
  const location=useLocation(), navigate=useNavigate();
  const {confirmEmail}=useAuth();
  const [token]=useState(() => location.hash.slice(1));
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [email,setEmail]=useState(location.state?.email ?? '');
  // Fragment is not sent to the web server; remove it after capturing to keep it out of history.
  useEffect(() => {if(location.hash)navigate('/confirm-email',{replace:true,state:location.state});},[]);
  async function confirm(){setBusy(true);setError('');try{await confirmEmail(token);navigate('/',{replace:true});}catch(err){setError(errorMessage(err));}finally{setBusy(false);}}
  async function resend(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);setError('');setMessage('');
    const form=new FormData(event.currentTarget);const next=String(form.get('newEmail')??'').trim();
    try {const result=await api<{message:string}>('/auth/confirmation',{method:'POST',body:{email,password:String(form.get('password')), ...(next ? {newEmail:next} : {})}});setMessage(result.message);}
    catch(err){setError(errorMessage(err));}finally{setBusy(false);}
  }
  if (token) return <main className="email-confirm-screen">
    <section className="email-confirm-card" aria-labelledby="email-confirm-title">
      <div className="email-confirm-brand">The Crafty Studio</div>
      <div className="email-confirm-content">
        <div className="email-confirm-icon" aria-hidden="true">✉</div>
        <h1 id="email-confirm-title">Confirm your email</h1>
        <p>One click and you’re ready to get started.</p>
        <button className="email-confirm-button" disabled={busy} onClick={() => void confirm()}>
          {busy ? 'Confirming…' : 'Confirm email'}
        </button>
        {error ? <div role="alert" className="email-confirm-error"><p>{error}</p>
          <a href="/confirm-email">Request a new confirmation email</a></div> : null}
      </div>
    </section>
  </main>;
  const deliveryDisabled = location.state?.emailSendingEnabled === false;
  return <main className="email-confirm-screen">
    <section className="email-confirm-card" aria-labelledby="email-confirm-title">
      <div className="email-confirm-brand">The Crafty Studio</div>
      <div className="email-confirm-content">
        <div className="email-confirm-icon" aria-hidden="true">✉</div>
        <h1 id="email-confirm-title">{deliveryDisabled ? 'Email unavailable' : location.state?.email ? 'Confirmation sent' : 'Check your email'}</h1>
        <p role="status">{deliveryDisabled ? 'Your account is saved. Please contact the studio to finish confirming your email.' : 'Open your email and select Confirm my email to continue.'}</p>
        <details className="email-confirm-help">
          <summary>Didn’t get the email?</summary>
          <p>Check your spam folder, or request a new link below.</p>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          {message ? <p role="status">{message}</p> : null}
          <form onSubmit={resend} className="stack-form">
            <label className="form-field"><span>Signup email</span><input type="email" required value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email" /></label>
            <label className="form-field"><span>Password</span><input name="password" type="password" required autoComplete="current-password" /></label>
            <label className="form-field"><span>Corrected email (optional)</span><input name="newEmail" type="email" /></label>
            <button className="button" disabled={busy}>Send confirmation email</button>
          </form>
          <Link to="/login">Back to login</Link>
        </details>
      </div>
    </section>
  </main>;
}
