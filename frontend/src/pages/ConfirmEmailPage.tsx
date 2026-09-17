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
  return <main className="page-shell"><section className="panel"><h1>Confirm your email</h1>
    {token ? <><p>Choose Confirm email to activate your account and sign in.</p><button className="button button--primary" disabled={busy} onClick={() => void confirm()}>Confirm email</button></> :
      <p>Your account needs email confirmation before you can sign in. Check your inbox and spam folder for “Confirm your email address”.</p>}
    {location.state?.emailSendingEnabled === false ? <p role="status">Email delivery is disabled in this environment. Your account is saved but cannot be confirmed until email delivery is enabled. Use a development demo account or contact the team.</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}
    <h2>Need another email?</h2><p>Enter your signup email and password to resend, or provide a corrected email. If you change it successfully, use that new address for future requests.</p>
    <form onSubmit={resend} className="stack-form">
      <label className="form-field"><span>Signup email</span><input type="email" required value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email" /></label>
      <label className="form-field"><span>Password</span><input name="password" type="password" required autoComplete="current-password" /></label>
      <label className="form-field"><span>Corrected email (optional)</span><input name="newEmail" type="email" /></label>
      <button className="button" disabled={busy}>Send confirmation email</button>
    </form><Link to="/login">Back to login</Link>
  </section></main>;
}
