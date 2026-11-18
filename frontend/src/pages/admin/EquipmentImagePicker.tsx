import { useRef, useState } from 'react';
import { ImagePlus, Upload } from 'lucide-react';
import { prepareEquipmentImage } from '../../lib/equipmentImage';
import './equipmentImagePicker.css';

export interface EquipmentImageOption { path: string; label: string }
export interface EquipmentImageChoice { path: string; upload?: string }

export function EquipmentImagePicker({ value, images, disabled, onChange, onProcessing }: {
  value: EquipmentImageChoice;
  images: EquipmentImageOption[];
  disabled: boolean;
  onChange: (value: EquipmentImageChoice) => void;
  onProcessing: (processing: boolean) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const [failedPreview, setFailedPreview] = useState('');
  const [fileName, setFileName] = useState('');
  const preview = value.upload || value.path || '/assets/3d-printer.webp';
  const caption = value.upload ? fileName : images.find(image => image.path === value.path)?.label
    ?? (value.path ? 'Current image' : 'Default image');
  const choose = (choice: EquipmentImageChoice) => { setError(''); onChange(choice); };

  return <fieldset className="eq-image" disabled={disabled}>
    <legend>Equipment image</legend>
    <div className="eq-image__selection">
      <div className="eq-image__preview">
        {failedPreview === preview ? <span>Preview unavailable</span> : <img src={preview} alt="Selected equipment image" onError={() => setFailedPreview(preview)} />}
      </div>
      <div className="eq-image__upload">
        <strong>{caption}</strong>
        <button type="button" className="button button--quiet" onClick={() => fileInput.current?.click()}><Upload aria-hidden="true" />{preparing ? 'Preparing image…' : 'Upload image'}</button>
        <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Upload equipment image" hidden onChange={async event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          setPreparing(true); onProcessing(true); setError('');
          try {
            const upload = await prepareEquipmentImage(file);
            setFileName(file.name);
            onChange({ path: '', upload });
          } catch (err) { setError(err instanceof Error ? err.message : 'Could not open this image.'); }
          finally { setPreparing(false); onProcessing(false); }
        }} />
        <small>JPEG, PNG or WebP, up to 25 MB. Saved when you save the equipment.</small>
        {(value.path || value.upload) && <button type="button" className="eq-image__reset" onClick={() => choose({ path: '' })}>Use default image</button>}
      </div>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <p className="eq-image__help">Choose an existing image</p>
    <div className="eq-image__library" role="group" aria-label="Existing equipment images">
      {images.map(image => <button key={image.path} type="button" className="eq-image__option" title={image.label} aria-pressed={!value.upload && value.path === image.path} onClick={() => choose({ path: image.path })}>
        <img src={image.path} alt="" loading="lazy" />
        <span>{image.label}</span>
      </button>)}
      {!images.length && <span>No saved images available yet. Upload one to get started.</span>}
    </div>
    <details className="eq-image__link">
      <summary><ImagePlus aria-hidden="true" />Use an image link or path</summary>
      <label>Image path or HTTPS URL<input maxLength={255} value={value.path} onChange={event => choose({ path: event.target.value })} placeholder="https://example.com/equipment.jpg" /><small>Existing built-in images are in /assets/. You can choose them above without typing a path.</small></label>
    </details>
  </fieldset>;
}
