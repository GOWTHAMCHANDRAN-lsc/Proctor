import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, FileSpreadsheet, CheckCircle, AlertCircle, Search, UserPlus, X, XCircle, FileWarning, Loader2, Download, Layers3, Building2, Plus, Trash2 } from 'lucide-react';
import { Batch, Student, UserRole, CompanyDirectoryRecord } from '../../types';
import { apiGet, apiPost } from '../../services/api';
import { Pagination, usePagination } from './Pagination';

interface CsvError {
  row: number;
  message: string;
}

interface StudentManagerProps {
  students: Student[];
  onUpdateStudents: React.Dispatch<React.SetStateAction<Student[]>>;
  role?: UserRole;
}

interface AdminCompanyContext {
  companyId: number | null;
  companyName: string | null;
  companyLabel: string;
}

const getAdminCompanyContext = (): AdminCompanyContext => {
  if (typeof window === 'undefined') {
    return { companyId: null, companyName: null, companyLabel: 'Current Company' };
  }

  try {
    const raw = localStorage.getItem('pg_admin_auth');
    if (!raw) {
      return { companyId: null, companyName: null, companyLabel: 'Current Company' };
    }

    const parsed = JSON.parse(raw);
    const companyId = Number(parsed?.companyId);
    const companyName = typeof parsed?.companyName === 'string' && parsed.companyName.trim() !== ''
      ? parsed.companyName.trim()
      : null;

    if (Number.isFinite(companyId) && companyId > 0) {
      return {
        companyId,
        companyName,
        companyLabel: companyName || `Company ${companyId}`,
      };
    }
  } catch {
    // ignore storage errors
  }

  return { companyId: null, companyName: null, companyLabel: 'Current Company' };
};

const parseCsvLine = (line: string): string[] => {
  const cols: string[] = [];
  let inQuote = false;
  let buffer = '';

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuote && next === '"') {
        buffer += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }

    if (char === ',' && !inQuote) {
      cols.push(buffer.trim());
      buffer = '';
      continue;
    }

    buffer += char;
  }

  cols.push(buffer.trim());
  return cols;
};

const mergeStudents = (current: Student[], incoming: Student[]) => {
  const map = new Map(current.map(student => [student.id, student]));
  incoming.forEach(student => {
    const existing = map.get(student.id);
    map.set(student.id, existing ? { ...existing, ...student } : student);
  });
  return Array.from(map.values());
};

export const StudentManager: React.FC<StudentManagerProps> = ({ students: propStudents, onUpdateStudents: propOnUpdateStudents, role }) => {
  const companyContext = useMemo(() => getAdminCompanyContext(), []);
  const isSuperAdmin = role === UserRole.SUPER_ADMIN;

  // Super admin operates across every tenant: it maintains its own per-company student
  // list and company selector. A regular admin stays bound to its own company via props.
  const [companies, setCompanies] = useState<CompanyDirectoryRecord[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | ''>('');
  const [superStudents, setSuperStudents] = useState<Student[]>([]);
  const [superStudentsLoading, setSuperStudentsLoading] = useState(false);

  // Effective bindings — the rest of the component uses these transparently.
  const students = isSuperAdmin ? superStudents : propStudents;
  const onUpdateStudents = isSuperAdmin ? setSuperStudents : propOnUpdateStudents;
  const effectiveCompanyId = isSuperAdmin ? (selectedCompanyId === '' ? null : selectedCompanyId) : companyContext.companyId;
  const effectiveCompanyLabel = isSuperAdmin
    ? (companies.find(c => c.id === selectedCompanyId)?.name || 'Select a company')
    : companyContext.companyLabel;
  // Extra query string that pins super-admin requests to the chosen company.
  const companyQuery = isSuperAdmin && effectiveCompanyId ? `?companyId=${effectiveCompanyId}` : '';

  const [isAddingStudent, setIsAddingStudent] = useState(false);
  const [isCreatingBatch, setIsCreatingBatch] = useState(false);
  const [search, setSearch] = useState('');
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState('');
  const [selectedBatchId, setSelectedBatchId] = useState<number | ''>('');

  const [newBatch, setNewBatch] = useState({ name: '', description: '' });
  const [newStudent, setNewStudent] = useState({ fullName: '', email: '', registrationId: '' });

  const [deleteStudentTarget, setDeleteStudentTarget] = useState<Student | null>(null);
  const [deleteStudentBusy, setDeleteStudentBusy] = useState(false);
  const [removeFromBatchBusyId, setRemoveFromBatchBusyId] = useState<string | null>(null);
  const [confirmDeleteBatch, setConfirmDeleteBatch] = useState(false);
  const [deleteBatchBusy, setDeleteBatchBusy] = useState(false);

  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadStatus, setUploadStatus] = useState<'IDLE' | 'PROCESSING' | 'SUCCESS' | 'PARTIAL' | 'ERROR'>('IDLE');
  const [uploadMsg, setUploadMsg] = useState('');
  const [csvErrors, setCsvErrors] = useState<CsvError[]>([]);

  // Super admin: load the company list for the selector.
  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{ companies: CompanyDirectoryRecord[] }>('companies.php');
        if (cancelled) return;
        const list = data?.companies || [];
        setCompanies(list);
        setSelectedCompanyId(current => (current === '' ? (list[0]?.id ?? '') : current));
      } catch (e: any) {
        if (!cancelled) setBatchError(e?.message || 'Failed to load companies.');
      }
    })();
    return () => { cancelled = true; };
  }, [isSuperAdmin]);

  useEffect(() => {
    // A super admin must pick a company before any company-scoped data can be fetched.
    if (isSuperAdmin && !effectiveCompanyId) {
      setBatches([]);
      setSelectedBatchId('');
      return;
    }
    let cancelled = false;
    const loadBatches = async () => {
      setBatchLoading(true);
      setBatchError('');
      try {
        const data = await apiGet<{ batches: Batch[] }>(`batches.php${companyQuery}`);
        if (cancelled) return;
        const nextBatches = data?.batches || [];
        setBatches(nextBatches);
        setSelectedBatchId(current => {
          if (current !== '' && nextBatches.some(batch => batch.id === current)) {
            return current;
          }
          return nextBatches[0]?.id ?? '';
        });
      } catch (e: any) {
        if (!cancelled) {
          setBatchError(e?.message || 'Failed to load batches.');
        }
      } finally {
        if (!cancelled) {
          setBatchLoading(false);
        }
      }
    };

    loadBatches();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin, effectiveCompanyId, companyQuery]);

  // Super admin: (re)load the selected company's students.
  useEffect(() => {
    if (!isSuperAdmin) return;
    if (!effectiveCompanyId) {
      setSuperStudents([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setSuperStudentsLoading(true);
      try {
        const data = await apiGet<{ students: Student[] }>(`students.php${companyQuery}`);
        if (!cancelled) setSuperStudents(data?.students || []);
      } catch {
        if (!cancelled) setSuperStudents([]);
      } finally {
        if (!cancelled) setSuperStudentsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isSuperAdmin, effectiveCompanyId, companyQuery]);

  const selectedBatch = useMemo(
    () => batches.find(batch => batch.id === selectedBatchId) || null,
    [batches, selectedBatchId]
  );

  const filteredStudents = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return students;

    return students.filter(student =>
      [student.fullName, student.email, student.registrationId, student.company || '', ...(student.batches || []).map(b => b.name)]
        .some(value => value.toLowerCase().includes(query))
    );
  }, [search, students]);

  const studentPaging = usePagination(filteredStudents, search);

  const batchCount = batches.length;

  const createBatch = async () => {
    if (!newBatch.name.trim()) {
      alert('Batch name is required.');
      return;
    }

    try {
      const result = await apiPost<{ batch: Batch; created: boolean }>('batches.php', {
        name: newBatch.name.trim(),
        description: newBatch.description.trim(),
        companyId: effectiveCompanyId,
      });

      const batch = result.batch;
      setBatches(prev => {
        const exists = prev.some(item => item.id === batch.id);
        const next = exists
          ? prev.map(item => (item.id === batch.id ? { ...item, ...batch } : item))
          : [batch, ...prev];
        return next;
      });
      setSelectedBatchId(batch.id);
      setIsCreatingBatch(false);
      setNewBatch({ name: '', description: '' });
      setBatchError('');
    } catch (e: any) {
      console.error(e);
      alert(e?.message || 'Failed to create batch.');
    }
  };

  const handleAddStudent = async () => {
    if (!selectedBatch) {
      alert('Create or select a batch first.');
      return;
    }
    if (!newStudent.fullName || !newStudent.email || !newStudent.registrationId) {
      alert('Full name, email, and registration ID are required.');
      return;
    }

    const existingMatch = students.find(s => s.registrationId === newStudent.registrationId || s.email === newStudent.email);
    if (existingMatch && existingMatch.batches.some(b => b.id === selectedBatch.id)) {
      alert('This student is already in this batch.');
      return;
    }

    try {
      const result = await apiPost<{ students: Student[]; errors?: string[] }>('students.php', {
        ...newStudent,
        companyId: effectiveCompanyId,
        batchId: selectedBatch.id,
        batch: selectedBatch.name,
      });

      if (result.errors?.length) {
        alert(result.errors.join('\n'));
        return;
      }

      if (result.students?.length) {
        onUpdateStudents(prev => mergeStudents(prev, result.students));
        setIsAddingStudent(false);
        setNewStudent({ fullName: '', email: '', registrationId: '' });
        setBatches(prev => prev.map(batch => (
          batch.id === selectedBatch.id
            ? { ...batch, studentCount: (batch.studentCount || 0) + result.students.length }
            : batch
        )));
      } else {
        alert('No student was created. Please try again.');
      }
    } catch (e: any) {
      console.error(e);
      alert('Failed to save student to database.');
    }
  };

  const refreshBatches = async () => {
    // Keep the company scope — for a super admin this must stay pinned to the selected company,
    // otherwise the batch list gets clobbered with a different company's batches after an upload.
    try {
      const data = await apiGet<{ batches: Batch[] }>(`batches.php${companyQuery}`);
      setBatches(data?.batches || []);
    } catch (e) {
      console.error('Failed to refresh batches:', e);
    }
  };

  const handleDeleteStudent = async () => {
    if (!deleteStudentTarget || deleteStudentBusy) return;
    setDeleteStudentBusy(true);
    try {
      await apiPost<{ ok: boolean; id: string }>('students.php', {
        action: 'delete',
        id: deleteStudentTarget.id,
        companyId: effectiveCompanyId,
      });
      const removed = deleteStudentTarget;
      onUpdateStudents(prev => prev.filter(s => s.id !== removed.id));
      // Keep the batch tally in sync with the removed student, across every batch they were in.
      const removedBatchIds = new Set((removed.batches || []).map(b => b.id));
      if (removedBatchIds.size > 0) {
        setBatches(prev => prev.map(batch => (
          removedBatchIds.has(batch.id) && typeof batch.studentCount === 'number'
            ? { ...batch, studentCount: Math.max(0, batch.studentCount - 1) }
            : batch
        )));
      }
      setDeleteStudentTarget(null);
    } catch (e: any) {
      console.error(e);
      alert(e?.message || 'Failed to delete student.');
    } finally {
      setDeleteStudentBusy(false);
    }
  };

  const handleRemoveFromBatch = async (student: Student) => {
    if (!selectedBatch || removeFromBatchBusyId) return;
    setRemoveFromBatchBusyId(student.id);
    try {
      await apiPost<{ ok: boolean }>('students.php', {
        action: 'unenroll',
        studentId: student.id,
        batchId: selectedBatch.id,
        companyId: effectiveCompanyId,
      });
      const removedId = selectedBatch.id;
      onUpdateStudents(prev => prev.map(s => (
        s.id === student.id ? { ...s, batches: s.batches.filter(b => b.id !== removedId) } : s
      )));
      setBatches(prev => prev.map(batch => (
        batch.id === removedId && typeof batch.studentCount === 'number'
          ? { ...batch, studentCount: Math.max(0, batch.studentCount - 1) }
          : batch
      )));
    } catch (e: any) {
      console.error(e);
      alert(e?.message || 'Failed to remove student from batch.');
    } finally {
      setRemoveFromBatchBusyId(null);
    }
  };

  const handleDeleteBatch = async () => {
    if (!selectedBatch || deleteBatchBusy) return;
    setDeleteBatchBusy(true);
    try {
      await apiPost<{ ok: boolean; id: number }>('batches.php', {
        action: 'delete',
        id: selectedBatch.id,
        companyId: effectiveCompanyId,
      });
      const removedId = selectedBatch.id;
      // Students aren't deleted — they're just no longer enrolled in this batch (their
      // other batch enrollments, if any, are untouched).
      onUpdateStudents(prev => prev.map(s => (
        s.batches.some(b => b.id === removedId)
          ? { ...s, batches: s.batches.filter(b => b.id !== removedId) }
          : s
      )));
      setBatches(prev => prev.filter(b => b.id !== removedId));
      setSelectedBatchId(current => (current === removedId ? '' : current));
      setConfirmDeleteBatch(false);
    } catch (e: any) {
      console.error(e);
      alert(e?.message || 'Failed to delete batch.');
    } finally {
      setDeleteBatchBusy(false);
    }
  };

  const downloadTemplate = () => {
    const headers = 'Full Name,Registration ID,Email\n';
    const sample = 'John Doe,REG2024003,john.doe@example.com\nJane Smith,REG2024004,jane.smith@example.com';
    const csvContent = `data:text/csv;charset=utf-8,${headers}${sample}`;
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', 'student_template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const exportStudents = () => {
    const rows = [
      ['Company', 'Batch', 'Full Name', 'Registration ID', 'Email'],
      ...students.map(student => [
        student.company || effectiveCompanyLabel,
        student.batches.map(b => b.name).join(', '),
        student.fullName,
        student.registrationId,
        student.email,
      ]),
    ];
    const csv = rows
      .map(row => row.map(value => {
        const str = String(value ?? '');
        return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
      }).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `students_export_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const HEADER_ALIASES: Record<'name' | 'regId' | 'email', string[]> = {
    name: ['full name', 'fullname', 'name', 'student name'],
    regId: ['registration id', 'registrationid', 'reg id', 'reg no', 'registration no', 'id', 'student id'],
    email: ['email', 'email address', 'e-mail'],
  };

  const findHeaderIndex = (headerCols: string[], aliases: string[]) =>
    headerCols.findIndex(h => aliases.includes(h.replace(/^"|"$/g, '').trim().toLowerCase()));

  const parseCSV = (text: string) => {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    const newStudents: Student[] = [];
    const errors: CsvError[] = [];

    const headerLine = lines[0]?.trim();
    if (!headerLine) {
      errors.push({ row: 1, message: 'Missing header row. Use Full Name,Registration ID,Email.' });
      return { newStudents, errors };
    }

    const headerCols = parseCsvLine(headerLine);
    const nameIdx = findHeaderIndex(headerCols, HEADER_ALIASES.name);
    const regIdIdx = findHeaderIndex(headerCols, HEADER_ALIASES.regId);
    const emailIdx = findHeaderIndex(headerCols, HEADER_ALIASES.email);

    if (nameIdx === -1 || regIdIdx === -1 || emailIdx === -1) {
      errors.push({ row: 1, message: 'Missing columns. Use headers: Full Name,Registration ID,Email.' });
      return { newStudents, errors };
    }

    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = parseCsvLine(line).map(value => value.replace(/^"|"$/g, '').trim());
      const name = cols[nameIdx] ?? '';
      const regId = cols[regIdIdx] ?? '';
      const email = cols[emailIdx] ?? '';

      if (!name || !regId || !email) {
        errors.push({ row: i + 1, message: 'Empty fields detected.' });
        continue;
      }
      if (!email.includes('@')) {
        errors.push({ row: i + 1, message: `Invalid email format: ${email}` });
        continue;
      }
      if (newStudents.some(s => s.registrationId === regId || s.email === email)) {
        errors.push({ row: i + 1, message: `Duplicate ID or Email inside file: ${regId} / ${email}` });
        continue;
      }

      newStudents.push({
        id: Math.random().toString(36).slice(2, 11),
        fullName: name,
        registrationId: regId,
        email,
        batches: [],
      });
    }

    return { newStudents, errors };
  };

  const handleFileUpload = (file: File) => {
    if (!selectedBatch) {
      setUploadStatus('ERROR');
      setUploadMsg('Create or select a batch first.');
      setCsvErrors([]);
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setUploadStatus('ERROR');
      setUploadMsg('File too large. Max size is 10MB.');
      setCsvErrors([]);
      return;
    }

    setUploadStatus('PROCESSING');
    setCsvErrors([]);
    setUploadMsg(`Uploading students into ${selectedBatch.name}...`);

    const reader = new FileReader();
    reader.onload = event => {
      const text = event.target?.result as string;

      setTimeout(async () => {
        const { newStudents, errors } = parseCSV(text);

        if (newStudents.length > 0) {
          try {
            const result = await apiPost<{ students: Student[]; errors?: string[] }>('students.php', {
              students: newStudents.map(student => ({
                ...student,
                companyId: effectiveCompanyId,
                batchId: selectedBatch.id,
                batch: selectedBatch.name,
              })),
            });

            const saved = result.students || [];
            if (saved.length > 0) {
              onUpdateStudents(prev => mergeStudents(prev, saved));
              // Pull authoritative batch counts back from the server.
              refreshBatches();
            }

            const serverErrors = (result.errors || []).map(message => ({
              row: 0,
              message,
            }));
            const combinedErrors = [...errors, ...serverErrors];
            setCsvErrors(combinedErrors);

            if (saved.length > 0 && combinedErrors.length === 0) {
              setUploadStatus('SUCCESS');
              setUploadMsg(`Saved ${saved.length} students into batch ${selectedBatch.name}.`);
            } else if (saved.length > 0) {
              setUploadStatus('PARTIAL');
              setUploadMsg(`Saved ${saved.length} students into batch ${selectedBatch.name}. ${combinedErrors.length} rows were skipped.`);
            } else {
              setUploadStatus('ERROR');
              setUploadMsg('No students were added. Please check the error log below.');
            }
          } catch (e) {
            console.error(e);
            setUploadStatus('ERROR');
            setUploadMsg('Failed to save students to database.');
            setCsvErrors(errors);
          }
        } else {
          setUploadStatus('ERROR');
          setUploadMsg(errors.length > 0 ? 'No valid students found. Please check the error log below.' : 'The file appears to be empty or invalid.');
          setCsvErrors(errors);
        }
      }, 800);
    };

    reader.onerror = () => {
      setUploadStatus('ERROR');
      setUploadMsg('Failed to read file.');
    };

    reader.readAsText(file);
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      if (e.dataTransfer.files[0].type !== 'text/csv' && !e.dataTransfer.files[0].name.endsWith('.csv')) {
        setUploadStatus('ERROR');
        setUploadMsg('Invalid file type. Please upload a CSV file.');
        return;
      }
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="lsc-title">Student Registry</h2>
          <p className="lsc-subtitle mt-1">Admins create batches first, then assign students into the selected batch.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isSuperAdmin && (
            <select
              value={selectedCompanyId}
              onChange={e => setSelectedCompanyId(e.target.value === '' ? '' : Number(e.target.value))}
              className="px-3 py-2 border border-slate-200 rounded-lg bg-white text-sm outline-none min-w-[200px]"
              title="Select a company to manage its students"
            >
              <option value="">Select a company…</option>
              {companies.map(company => (
                <option key={company.id} value={company.id}>{company.name}</option>
              ))}
            </select>
          )}
          <button onClick={downloadTemplate} className="px-4 py-2 lsc-button-ghost flex items-center gap-2 text-sm">
            <Download size={16} className="text-[var(--lsc-primary)]" /> Template
          </button>
          <button onClick={exportStudents} className="px-4 py-2 lsc-button-ghost flex items-center gap-2 text-sm">
            <Download size={16} className="text-[#1e8e3e]" /> Export
          </button>
          <button onClick={() => setIsCreatingBatch(true)} className="px-4 py-2 lsc-button-ghost flex items-center gap-2 text-sm">
            <Plus size={16} /> Create Batch
          </button>
          <button
            onClick={() => {
              if (!selectedBatch) {
                alert('Create or select a batch first.');
                return;
              }
              setIsAddingStudent(true);
            }}
            className="px-4 py-2 lsc-button-primary flex items-center gap-2 text-sm"
          >
            <UserPlus size={16} /> Add Student
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="lsc-panel p-4 flex items-start gap-3">
          <div className="lsc-icon-tile-primary p-2">
            <Building2 size={18} />
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Company Scope</p>
            <p className="text-sm font-semibold text-slate-900">{effectiveCompanyLabel}</p>
            <p className="text-xs text-slate-500 mt-1">
              {isSuperAdmin
                ? 'Super admin — pick a company above to manage its students.'
                : 'Only the current authenticated company scope is used here.'}
            </p>
          </div>
        </div>
        <div className="lsc-panel p-4 flex items-start gap-3">
          <div className="lsc-icon-tile-success p-2">
            <Layers3 size={18} />
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Available Batches</p>
            <p className="text-sm font-semibold text-slate-900">{batchCount}</p>
            <p className="text-xs text-slate-500 mt-1">Students are uploaded into the selected batch only.</p>
          </div>
        </div>
        <div className="lsc-panel p-4">
          <div className="flex items-center justify-between mb-2">
            <label className="block text-xs font-semibold text-slate-500 uppercase">Selected Batch</label>
            <button
              type="button"
              onClick={() => setConfirmDeleteBatch(true)}
              disabled={!selectedBatch}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-red-600 disabled:opacity-40 disabled:hover:text-slate-400"
              title={selectedBatch ? `Delete batch ${selectedBatch.name}` : 'Select a batch to delete'}
            >
              <Trash2 size={13} /> Delete
            </button>
          </div>
          <select
            value={selectedBatchId}
            onChange={e => setSelectedBatchId(e.target.value ? Number(e.target.value) : '')}
            className="w-full p-2.5 border border-slate-200 rounded-lg outline-none transition-all bg-white"
            disabled={batchLoading}
          >
            <option value="">Select batch</option>
            {batches.map(batch => (
              <option key={batch.id} value={batch.id}>
                {batch.name}{typeof batch.studentCount === 'number' ? ` (${batch.studentCount})` : ''}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-500 mt-2">
            {selectedBatch ? `Students will be added to ${selectedBatch.name}.` : 'Create a batch first, then choose it here.'}
          </p>
          {batchError && <p className="text-xs text-red-600 mt-2">{batchError}</p>}
        </div>
      </div>

      {isCreatingBatch && (
        <div className="lsc-panel p-4 sm:p-6 animate-in fade-in slide-in-from-top-4 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-[#1e8e3e]"></div>
          <div className="flex justify-between mb-6">
            <div>
              <h3 className="font-bold text-slate-900 text-lg">Create Batch</h3>
              <p className="text-sm text-slate-500">Create the batch first, then choose it from the dropdown for student upload.</p>
            </div>
            <button onClick={() => setIsCreatingBatch(false)} className="bg-slate-100 p-1.5 rounded-full hover:bg-slate-200 transition-colors">
              <X size={18} className="text-slate-500 hover:text-slate-700" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Company</label>
              <input type="text" className="w-full p-2.5 border border-slate-200 rounded-lg bg-slate-50 text-slate-600" value={effectiveCompanyLabel} readOnly />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Batch Name</label>
              <input
                type="text"
                placeholder="e.g. Batch A"
                className="w-full p-2.5 border border-slate-200 rounded-lg outline-none transition-all bg-white"
                value={newBatch.name}
                onChange={e => setNewBatch({ ...newBatch, name: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Description</label>
              <input
                type="text"
                placeholder="Optional notes"
                className="w-full p-2.5 border border-slate-200 rounded-lg outline-none transition-all bg-white"
                value={newBatch.description}
                onChange={e => setNewBatch({ ...newBatch, description: e.target.value })}
              />
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <button onClick={() => setIsCreatingBatch(false)} className="px-5 py-2 text-slate-600 hover:bg-slate-50 font-medium rounded-lg">Cancel</button>
            <button onClick={createBatch} className="px-6 py-2 lsc-button-primary">
              Save Batch
            </button>
          </div>
        </div>
      )}

      {isAddingStudent && (
        <div className="lsc-panel p-4 sm:p-6 animate-in fade-in slide-in-from-top-4 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-[var(--lsc-primary)]"></div>
          <div className="flex justify-between mb-6">
            <div>
              <h3 className="font-bold text-slate-900 text-lg">Add New Student</h3>
              <p className="text-sm text-slate-500">This student will be added to batch {selectedBatch?.name || 'selected batch'}.</p>
            </div>
            <button onClick={() => setIsAddingStudent(false)} className="bg-slate-100 p-1.5 rounded-full hover:bg-slate-200 transition-colors">
              <X size={18} className="text-slate-500 hover:text-slate-700" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-5">
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Company</label>
              <input type="text" className="w-full p-2.5 border border-slate-200 rounded-lg bg-slate-50 text-slate-600" value={effectiveCompanyLabel} readOnly />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Batch</label>
              <input type="text" className="w-full p-2.5 border border-slate-200 rounded-lg bg-slate-50 text-slate-600" value={selectedBatch?.name || ''} readOnly />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Full Name</label>
              <input
                type="text"
                placeholder="e.g. John Doe"
                className="w-full p-2.5 border border-slate-200 rounded-lg outline-none transition-all bg-white"
                value={newStudent.fullName}
                onChange={e => setNewStudent({ ...newStudent, fullName: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Registration ID</label>
              <input
                type="text"
                placeholder="e.g. REG-2024-001"
                className="w-full p-2.5 border border-slate-200 rounded-lg outline-none transition-all bg-white"
                value={newStudent.registrationId}
                onChange={e => setNewStudent({ ...newStudent, registrationId: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Email Address</label>
              <input
                type="email"
                placeholder="john@example.com"
                className="w-full p-2.5 border border-slate-200 rounded-lg outline-none transition-all bg-white"
                value={newStudent.email}
                onChange={e => setNewStudent({ ...newStudent, email: e.target.value })}
              />
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <button onClick={() => setIsAddingStudent(false)} className="px-5 py-2 text-slate-600 hover:bg-slate-50 font-medium rounded-lg">Cancel</button>
            <button onClick={handleAddStudent} className="px-6 py-2 lsc-button-primary">
              Save Record
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-1 space-y-4">
          <div
            className={`relative h-56 sm:h-72 rounded-xl border-2 border-dashed flex flex-col items-center justify-center p-6 text-center transition-all duration-300 ease-in-out cursor-pointer group overflow-hidden ${
              dragActive
                ? 'border-blue-500 bg-blue-50/50 scale-[0.99] ring-4 ring-blue-50'
                : uploadStatus === 'PROCESSING'
                  ? 'border-blue-200 bg-white cursor-wait'
                  : 'border-slate-300 bg-slate-50 hover:border-blue-400 hover:bg-white hover:shadow-md'
            }`}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={() => uploadStatus !== 'PROCESSING' && fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={e => e.target.files?.[0] && handleFileUpload(e.target.files[0])}
              accept=".csv"
              disabled={uploadStatus === 'PROCESSING'}
            />

            {uploadStatus === 'PROCESSING' ? (
              <div className="flex flex-col items-center animate-in fade-in zoom-in duration-300 z-10">
                <div className="relative">
                  <div className="absolute inset-0 bg-blue-200 rounded-full blur-xl opacity-50 animate-pulse"></div>
                  <Loader2 size={48} className="text-[var(--lsc-primary)] animate-spin relative z-10" />
                </div>
                <p className="text-blue-900 font-bold mt-6 text-lg">{uploadMsg}</p>
                <p className="text-blue-700/70 text-sm mt-1">Current batch: {selectedBatch?.name || 'Not selected'}</p>
              </div>
            ) : (
              <>
                <div className={`p-5 rounded-full mb-5 transition-all duration-300 ${dragActive ? 'bg-blue-100 scale-110' : 'bg-white shadow-sm group-hover:scale-110 group-hover:shadow-md group-hover:text-blue-600'}`}>
                  <Upload size={32} className={`transition-colors duration-300 ${dragActive ? 'text-blue-600' : 'text-slate-400 group-hover:text-blue-500'}`} />
                </div>
                <h4 className={`font-bold text-lg mb-2 transition-colors ${dragActive ? 'text-blue-700' : 'text-slate-700 group-hover:text-blue-700'}`}>
                  {dragActive ? 'Drop file here' : 'Upload Student Data'}
                </h4>
                <p className="text-slate-500 text-sm max-w-[220px] mx-auto leading-relaxed">
                  Select a batch first, then upload CSV with student name, registration ID, and email.
                </p>
                <div className="mt-6 flex items-center gap-2 text-xs font-medium text-slate-400 bg-slate-100 px-3 py-1 rounded-full group-hover:bg-blue-50 group-hover:text-blue-500 transition-colors">
                  <FileSpreadsheet size={12} />
                  <span>Max 10MB - CSV Only</span>
                </div>
              </>
            )}
          </div>

          {uploadStatus === 'SUCCESS' && (
            <div className="bg-teal-50 border border-teal-200 rounded-xl p-4 flex items-start gap-3 animate-in fade-in slide-in-from-top-2 shadow-sm">
              <div className="bg-teal-100 p-1.5 rounded-full shrink-0">
                <CheckCircle className="text-teal-600" size={18} />
              </div>
              <div>
                <h4 className="font-bold text-teal-900 text-sm">Upload Successful</h4>
                <p className="text-teal-700 text-sm mt-0.5 leading-snug">{uploadMsg}</p>
              </div>
            </div>
          )}

          {uploadStatus === 'PARTIAL' && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3 animate-in fade-in slide-in-from-top-2 shadow-sm">
              <div className="bg-amber-100 p-1.5 rounded-full shrink-0">
                <FileWarning className="text-amber-600" size={18} />
              </div>
              <div>
                <h4 className="font-bold text-amber-900 text-sm">Partial Success</h4>
                <p className="text-amber-700 text-sm mt-0.5 leading-snug">{uploadMsg}</p>
              </div>
            </div>
          )}

          {uploadStatus === 'ERROR' && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 animate-in fade-in slide-in-from-top-2 shadow-sm">
              <div className="bg-red-100 p-1.5 rounded-full shrink-0">
                <AlertCircle className="text-red-600" size={18} />
              </div>
              <div>
                <h4 className="font-bold text-red-900 text-sm">Upload Failed</h4>
                <p className="text-red-700 text-sm mt-0.5 leading-snug">{uploadMsg}</p>
              </div>
            </div>
          )}

          {csvErrors.length > 0 && (
            <div className="bg-white rounded-xl border border-red-200 shadow-sm overflow-hidden animate-in fade-in slide-in-from-top-2">
              <div className="px-4 py-3 bg-red-50 border-b border-red-100 flex items-center justify-between">
                <div className="flex items-center gap-2 text-red-800 text-xs font-bold uppercase tracking-wider">
                  <XCircle size={14} /> Validation Errors ({csvErrors.length})
                </div>
                <button onClick={() => setCsvErrors([])} className="text-red-400 hover:text-red-600"><X size={14} /></button>
              </div>
              <div className="max-h-48 overflow-auto lsc-table-wrap scrollbar-thin scrollbar-thumb-red-100 scrollbar-track-transparent">
                <table className="w-full text-left text-xs">
                  <tbody className="divide-y divide-red-50">
                    {csvErrors.map((err, i) => (
                      <tr key={i} className="hover:bg-red-50/50 transition-colors group">
                        <td className="px-4 py-2.5 font-mono text-red-600 w-16 font-semibold border-r border-red-50 group-hover:border-red-100">
                          {err.row === 0 ? 'Server' : `Row ${err.row}`}
                        </td>
                        <td className="px-4 py-2.5 text-red-800">{err.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="lg:col-span-2 lsc-panel overflow-hidden flex flex-col h-auto lg:h-[600px]">
          <div className="p-5 lsc-panel-header flex flex-wrap justify-between items-center gap-3 backdrop-blur-sm">
            <h3 className="font-bold text-slate-800">
              Registered Students
              <span className="ml-2 text-xs font-medium bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full">{filteredStudents.length}</span>
            </h3>
            <div className="relative group">
              <Search className="absolute left-3 top-2.5 text-slate-400 group-focus-within:text-blue-500 transition-colors" size={15} />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by name, ID, company, or batch..."
                className="pl-9 pr-4 py-2 text-sm border border-slate-200 rounded-lg outline-none w-full sm:w-72 transition-all bg-white"
              />
            </div>
          </div>
          <div className="overflow-y-auto flex-1 scrollbar-thin scrollbar-thumb-slate-200 hover:scrollbar-thumb-slate-300">
            <div className="lsc-table-wrap">
              <table className="w-full min-w-[1080px] text-left">
                <thead className="bg-white border-b border-slate-100 sticky top-0 z-10 shadow-sm">
                  <tr>
                    <th className="px-6 py-4 text-xs font-bold text-slate-400 uppercase tracking-wider bg-slate-50/80 backdrop-blur">Company</th>
                    <th className="px-6 py-4 text-xs font-bold text-slate-400 uppercase tracking-wider bg-slate-50/80 backdrop-blur">Batch</th>
                    <th className="px-6 py-4 text-xs font-bold text-slate-400 uppercase tracking-wider bg-slate-50/80 backdrop-blur">Registration ID</th>
                    <th className="px-6 py-4 text-xs font-bold text-slate-400 uppercase tracking-wider bg-slate-50/80 backdrop-blur">Full Name</th>
                    <th className="px-6 py-4 text-xs font-bold text-slate-400 uppercase tracking-wider bg-slate-50/80 backdrop-blur">Email Address</th>
                    <th className="px-6 py-4 text-xs font-bold text-slate-400 uppercase tracking-wider bg-slate-50/80 backdrop-blur text-center">Status</th>
                    <th className="px-6 py-4 text-xs font-bold text-slate-400 uppercase tracking-wider bg-slate-50/80 backdrop-blur text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {studentPaging.pageItems.map(student => (
                    <tr key={student.id} className="hover:bg-blue-50/30 transition-colors group">
                      <td className="px-6 py-4 text-sm text-slate-600 font-medium">{student.company || effectiveCompanyLabel}</td>
                      <td className="px-6 py-4 text-sm">
                        <div className="flex flex-wrap gap-1">
                          {student.batches.length > 0 ? student.batches.map(b => (
                            <span key={b.id} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-100 text-blue-700 text-[11px] font-semibold border border-blue-200">
                              <Layers3 size={12} /> {b.name}
                            </span>
                          )) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-100 text-slate-500 text-[11px] font-semibold border border-slate-200">
                              Unassigned
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-500 font-mono group-hover:text-blue-600 transition-colors">{student.registrationId}</td>
                      <td className="px-6 py-4 text-sm text-slate-900 font-semibold">
                        <div className="flex items-center gap-2">
                          <span>{student.fullName}</span>
                          {student.enrolled ? (
                            <span
                              title={student.enrolledAt ? `Face enrolled ${student.enrolledAt}` : 'Face enrolled'}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-[9px] font-bold uppercase tracking-wide border border-indigo-200"
                            >
                              <CheckCircle size={9} /> Face ID
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[9px] font-bold uppercase tracking-wide border border-slate-200">
                              No Face ID
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-500">{student.email}</td>
                      <td className="px-6 py-4 text-center">
                        {student.enrolled ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-teal-100 text-teal-700 text-[10px] font-bold uppercase tracking-wide border border-teal-200">
                            <CheckCircle size={10} /> Enrolled
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold uppercase tracking-wide border border-amber-200">
                            <AlertCircle size={10} /> Pending
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="inline-flex items-center gap-1">
                          {selectedBatch && student.batches.some(b => b.id === selectedBatch.id) && (
                            <button
                              type="button"
                              onClick={() => handleRemoveFromBatch(student)}
                              disabled={removeFromBatchBusyId === student.id}
                              className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-slate-400 hover:text-amber-600 hover:bg-amber-50 transition-colors disabled:opacity-50"
                              title={`Remove ${student.fullName} from ${selectedBatch.name} (keeps their other batches)`}
                              aria-label={`Remove ${student.fullName} from ${selectedBatch.name}`}
                            >
                              {removeFromBatchBusyId === student.id ? <Loader2 size={16} className="animate-spin" /> : <X size={16} />}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setDeleteStudentTarget(student)}
                            className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                            title={`Delete ${student.fullName} entirely (all batches)`}
                            aria-label={`Delete ${student.fullName} entirely`}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filteredStudents.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-20 text-center text-slate-400">
                        <div className="flex flex-col items-center justify-center">
                          <div className="bg-slate-100 p-4 rounded-full mb-3">
                            <UserPlus size={24} className="text-slate-300" />
                          </div>
                          {isSuperAdmin && superStudentsLoading ? (
                            <p className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Loading students…</p>
                          ) : isSuperAdmin && !effectiveCompanyId ? (
                            <p>Select a company above to view its students.</p>
                          ) : (
                            <>
                              <p>No students found for this company or filter.</p>
                              <p className="text-xs mt-1">Create a batch first, then add or upload students into it.</p>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          {studentPaging.totalPages > 1 ? (
            <Pagination state={studentPaging} label="students" />
          ) : (
            <div className="bg-slate-50 p-3 border-t border-slate-200 text-xs text-center text-slate-400">
              Showing {filteredStudents.length} of {students.length} records
            </div>
          )}
        </div>
      </div>

      {deleteStudentTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40" onClick={() => !deleteStudentBusy && setDeleteStudentTarget(null)}>
          <div className="lsc-card w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <div className="lsc-icon-tile-danger p-2.5 shrink-0">
                <Trash2 size={18} />
              </div>
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-slate-900">Delete student?</h3>
                <p className="text-sm text-slate-500 mt-1">
                  This permanently removes <span className="font-medium text-slate-800">{deleteStudentTarget.fullName}</span> ({deleteStudentTarget.registrationId}) and all of their exam sessions and results. This can't be undone.
                </p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setDeleteStudentTarget(null)}
                disabled={deleteStudentBusy}
                className="px-5 py-2 lsc-button-ghost text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteStudent}
                disabled={deleteStudentBusy}
                className="px-5 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-60 flex items-center gap-2"
              >
                {deleteStudentBusy && <Loader2 size={15} className="animate-spin" />}
                {deleteStudentBusy ? 'Deleting…' : 'Delete student'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteBatch && selectedBatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40" onClick={() => !deleteBatchBusy && setConfirmDeleteBatch(false)}>
          <div className="lsc-card w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <div className="lsc-icon-tile-danger p-2.5 shrink-0">
                <Trash2 size={18} />
              </div>
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-slate-900">Delete batch?</h3>
                <p className="text-sm text-slate-500 mt-1">
                  This deletes <span className="font-medium text-slate-800">{selectedBatch.name}</span>. Students in this batch are kept but moved to <span className="font-medium text-slate-800">Unassigned</span>, and any exam links to this batch are removed.
                </p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setConfirmDeleteBatch(false)}
                disabled={deleteBatchBusy}
                className="px-5 py-2 lsc-button-ghost text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteBatch}
                disabled={deleteBatchBusy}
                className="px-5 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-60 flex items-center gap-2"
              >
                {deleteBatchBusy && <Loader2 size={15} className="animate-spin" />}
                {deleteBatchBusy ? 'Deleting…' : 'Delete batch'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
