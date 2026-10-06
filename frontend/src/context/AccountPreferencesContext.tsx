import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from 'react';
import { api, errorMessage } from '../lib/api';
import type { AccountPreferences, AccountPreferencesPatch } from '../lib/contracts';

export const defaultAccountPreferences: AccountPreferences = {
    notifications: {
        reservations: true,
        classes: true,
        membershipPayments: true,
    },
    accessibility: {
        largeText: false,
        highContrast: false,
        reducedMotion: false,
    },
};

interface AccountPreferencesContextValue {
    preferences: AccountPreferences;
    loading: boolean;
    error: string;
    save: (patch: AccountPreferencesPatch) => Promise<void>;
    reload: () => Promise<void>;
}

const AccountPreferencesContext =
    createContext<AccountPreferencesContextValue | null>(null);

export function AccountPreferencesProvider({ children }: { children: ReactNode }) {
    const [preferences, setPreferences] = useState(defaultAccountPreferences);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const reload = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            setPreferences(await api<AccountPreferences>('/me/preferences'));
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void reload();
    }, [reload]);

    const save = useCallback(async (patch: AccountPreferencesPatch) => {
        setError('');
        try {
            setPreferences(
                await api<AccountPreferences>('/me/preferences', {
                    method: 'PATCH',
                    body: patch,
                }),
            );
        } catch (err) {
            setError(errorMessage(err));
            throw err;
        }
    }, []);

    const value = useMemo(
        () => ({ preferences, loading, error, save, reload }),
        [preferences, loading, error, save, reload],
    );
    return (
        <AccountPreferencesContext.Provider value={value}>
            {children}
        </AccountPreferencesContext.Provider>
    );
}

export function useAccountPreferences() {
    const value = useContext(AccountPreferencesContext);
    if (!value)
        throw new Error(
            'useAccountPreferences must be used within AccountPreferencesProvider',
        );
    return value;
}
