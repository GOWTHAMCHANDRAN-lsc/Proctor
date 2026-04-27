import React, { useState, useRef } from 'react';
import { Batch, Exam, Question, QuestionType, Student, NotificationTemplate } from '../../types';
import { Plus, Trash2, Save, FileSpreadsheet, Upload, Download, CheckCircle, AlertCircle, Share2, Calendar, Clock, XCircle, FileWarning, Users, Search, Lock, Mail, Send, Loader2, Shuffle, Bell, ListOrdered, Eye, AlignLeft, CheckSquare, Copy } from 'lucide-react';
import { ExamTake } from '../student/ExamTake';
import { apiGet, apiPost } from '../../services/api';

// Helper for input type="datetime-local"
const toLocalISOString = (date: Date) => {
  const pad = (num: number) => num.toString().padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

const readTextFile = async (file: File) => {
  const buffer = await file.arrayBuffer();
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return decoder.decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    const decoder = new TextDecoder('windows-1252');
    return decoder.decode(buffer).replace(/^\uFEFF/, '');
  }
};

const getAdminCompanyId = () => {
  if (typeof window === 'undefined') return 1;
  try {
    const raw = localStorage.getItem('pg_admin_auth');
    if (!raw) return 1;
    const parsed = JSON.parse(raw);
    const companyId = Number(parsed?.companyId);
    return Number.isFinite(companyId) && companyId > 0 ? companyId : 1;
  } catch {
    return 1;
  }
};

const defaultViolationLimits = {
  camera: 0,
  microphone: 0,
  fullscreen: 0,
  copyPaste: 0,
};

const defaultProctoringConfig: Exam['proctoringConfig'] = {
  cameraRequired: true,
  microphoneRequired: false,
  fullScreenEnforced: true,
  tabSwitchLimit: 3,
  violationLimits: { ...defaultViolationLimits },
};

interface CsvError {
  row: number;
  message: string;
  rawData: string;
}

interface ExamManagerProps {
  students: Student[];
  exams: Exam[];
  onUpdateExams: React.Dispatch<React.SetStateAction<Exam[]>>;
  onUpdateStudents?: React.Dispatch<React.SetStateAction<Student[]>>;
}

export const ExamManager: React.FC<ExamManagerProps> = ({ students, exams, onUpdateExams, onUpdateStudents }) => {
  const [isCreating, setIsCreating] = useState(false);
  const [batchSearch, setBatchSearch] = useState('');
  const [emailSendingId, setEmailSendingId] = useState<string | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Exam | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  
  // Preview State
  const [showPreview, setShowPreview] = useState(false);
  
  // New Exam State
  const [newExam, setNewExam] = useState<Partial<Exam>>({
    title: '',
    durationMinutes: 60,
    startTime: Date.now(),
    endTime: Date.now() + 86400000 * 2, // Default +2 days
    questions: [],
    sections: [],
    questionCount: 0, // 0 means all
    shuffleQuestions: true, // Default to true for security
    showResults: false,
    reconnectLimit: 1,
    passPercent: 60,
    proctoringConfig: { ...defaultProctoringConfig },
    totalMarks: 0,
    assignedStudentIds: [],
    assignedBatchIds: [],
    status: 'DRAFT',
    notificationConfig: {
      enabled: false,
      reminders: { hours24: true, hours1: true },
      customSubject: '',
      customMessage: ''
    }
  });

  const sections = newExam.sections || [];
  const useSections = sections.length > 0;

  // Manual Question State
  const [manualQ, setManualQ] = useState<{
    type: QuestionType;
    text: string;
    options: string[];
    correctIdx: number;
    marks: number;
  }>({
    type: QuestionType.MCQ,
    text: '',
    options: ['', '', '', ''],
    correctIdx: 0,
    marks: 1
  });

  // Question Upload State
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadStatus, setUploadStatus] = useState<'IDLE' | 'SUCCESS' | 'ERROR' | 'PARTIAL'>('IDLE');
  const [uploadMsg, setUploadMsg] = useState('');
  const [csvErrors, setCsvErrors] = useState<CsvError[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    const loadTemplates = async () => {
      try {
        const data = await apiGet<{ templates: NotificationTemplate[] }>('templates.php?channel=EMAIL');
        if (!cancelled) {
          setTemplates(data?.templates || []);
        }
      } catch (e) {
        console.error('Failed to load templates:', e);
      }
    };
    loadTemplates();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const loadBatches = async () => {
      try {
        const data = await apiGet<{ batches: Batch[] }>('batches.php');
        if (!cancelled) {
          setBatches(data?.batches || []);
        }
      } catch (e) {
        console.error('Failed to load batches:', e);
      }
    };
    loadBatches();
    return () => {
      cancelled = true;
    };
  }, []);

  // Batch Assign State
  const studentBatchInputRef = useRef<HTMLInputElement>(null);
  const examImportRef = useRef<HTMLInputElement>(null);
  const studentCreateInputRef = useRef<HTMLInputElement>(null);

  const createSection = (title: string, order: number) => ({
    id: Math.random().toString(36).substr(2, 9),
    title,
    questionLimit: 0,
    shuffleQuestions: true,
    timeLimitMinutes: 0,
    lockOnComplete: true,
    displayOrder: order,
    questions: []
  });

  const enableSections = () => {
    if (useSections) return;
    const first = createSection('Section 1', 0);
    setNewExam(prev => ({
      ...prev,
      sections: [first],
      questions: (prev.questions || []).map(q => ({ ...q, sectionId: first.id }))
    }));
    setActiveSectionId(first.id);
  };

  const disableSections = () => {
    setNewExam(prev => ({ ...prev, sections: [] }));
    setActiveSectionId(null);
  };

  const getSectionQuestionCount = (sectionId: string) => {
    return (newExam.questions || []).filter(q => q.sectionId === sectionId).length;
  };

  const handleAddManualQuestion = () => {
    if (!manualQ.text) {
      alert("Please enter the question text.");
      return;
    }

    if (manualQ.type === QuestionType.MCQ && manualQ.options.some(o => !o.trim())) {
      alert("Please fill in all 4 options for Multiple Choice Questions.");
      return;
    }

    const newQuestion: Question = {
      id: Math.random().toString(36).substr(2, 9),
      text: manualQ.text,
      type: manualQ.type,
      options: manualQ.type === QuestionType.MCQ ? [...manualQ.options] : undefined,
      correctOptionIndex: manualQ.type === QuestionType.MCQ ? manualQ.correctIdx : undefined,
      marks: manualQ.marks,
      sectionId: useSections ? (activeSectionId || sections[0]?.id) : undefined
    };

    setNewExam(prev => ({
      ...prev,
      questions: [...(prev.questions || []), newQuestion]
    }));

    // Reset form
    setManualQ({
      type: QuestionType.MCQ,
      text: '',
      options: ['', '', '', ''],
      correctIdx: 0,
      marks: 1
    });
  };

  const updateOption = (idx: number, val: string) => {
    const newOptions = [...manualQ.options];
    newOptions[idx] = val;
    setManualQ({ ...manualQ, options: newOptions });
  };

  const removeQuestion = (id: string) => {
    setNewExam(prev => ({
      ...prev,
      questions: prev.questions?.filter(q => q.id !== id) || []
    }));
  };

  const getStudentIdsForBatchIds = (batchIds: number[]) => {
    if (batchIds.length === 0) return [];
    return Array.from(new Set(
      students
        .filter(student => student.batchId !== null && student.batchId !== undefined && batchIds.includes(Number(student.batchId)))
        .map(student => student.id)
    ));
  };

  const toggleBatch = (batchId: number) => {
    const current = newExam.assignedBatchIds || [];
    const nextBatchIds = current.includes(batchId)
      ? current.filter(id => id !== batchId)
      : [...current, batchId];

    setNewExam(prev => ({
      ...prev,
      assignedBatchIds: nextBatchIds,
      assignedStudentIds: getStudentIdsForBatchIds(nextBatchIds),
    }));
  };

  const handleSaveExam = async () => {
    if (!newExam.title || !newExam.questions?.length) return;
    if (newExam.startTime! >= newExam.endTime!) {
        alert("End time must be after start time");
        return;
    }

    const sectionsPayload = useSections
      ? sections.map((section, idx) => ({
          id: section.id,
          title: section.title,
          displayOrder: idx,
          questionLimit: section.questionLimit ?? 0,
          shuffleQuestions: section.shuffleQuestions ?? true,
          timeLimitMinutes: section.timeLimitMinutes ?? 0,
          lockOnComplete: section.lockOnComplete ?? true,
          questions: (newExam.questions || []).filter(q => q.sectionId === section.id)
        }))
      : [];

    const payload: Exam = {
      ...(newExam as Exam),
      id: newExam.id || Math.random().toString(36).substr(2, 9),
      status: newExam.status || 'DRAFT',
      totalMarks: newExam.questions.reduce((sum, q) => sum + q.marks, 0),
      sections: sectionsPayload,
      assignedBatchIds: newExam.assignedBatchIds || [],
      assignedStudentIds: getStudentIdsForBatchIds(newExam.assignedBatchIds || []),
    };

    try {
      const result = await apiPost<{ exam: Exam }>('exams.php', { exam: payload });
      const savedExam = result.exam || payload;
      onUpdateExams(prev => {
        const exists = prev.some(e => e.id === savedExam.id);
        return exists ? prev.map(e => (e.id === savedExam.id ? savedExam : e)) : [savedExam, ...prev];
      });
    } catch (e) {
      console.error(e);
      alert('Failed to save exam to database.');
      return;
    }
    
    resetForm();
  };

  const handleEditExam = (exam: Exam) => {
    const normalizedSections = (exam.sections || []).map((section, idx) => ({
      ...section,
      displayOrder: section.displayOrder ?? idx,
      questionLimit: section.questionLimit ?? 0,
      shuffleQuestions: section.shuffleQuestions ?? true,
      timeLimitMinutes: section.timeLimitMinutes ?? 0,
      lockOnComplete: section.lockOnComplete ?? true,
    }));
    const sectionMap = new Map<string, string>();
    if (normalizedSections.length > 0) {
      normalizedSections.forEach(section => {
        section.questions.forEach(q => {
          sectionMap.set(q.id, section.id);
        });
      });
    }
    const questionsWithSections = (exam.questions || []).map(q => ({
      ...q,
      sectionId: sectionMap.get(q.id)
    }));
    setNewExam({ 
        ...exam, 
        sections: normalizedSections,
        assignedStudentIds: exam.assignedStudentIds || [],
        assignedBatchIds: exam.assignedBatchIds || [],
        questions: questionsWithSections,
        shuffleQuestions: exam.shuffleQuestions ?? true, // Default to true if undefined
        showResults: exam.showResults ?? false,
        reconnectLimit: exam.reconnectLimit ?? 0,
        passPercent: exam.passPercent ?? 60,
        proctoringConfig: {
          ...defaultProctoringConfig,
          ...(exam.proctoringConfig || {}),
          tabSwitchLimit: Math.max(0, Number(exam.proctoringConfig?.tabSwitchLimit ?? defaultProctoringConfig.tabSwitchLimit)),
          violationLimits: {
            ...defaultViolationLimits,
            ...(exam.proctoringConfig?.violationLimits || {})
          }
        },
        notificationConfig: exam.notificationConfig || {
        enabled: false,
        reminders: { hours24: true, hours1: true },
        customSubject: `Reminder: ${exam.title}`,
        customMessage: 'Please ensure your environment is ready 15 minutes before the exam starts.'
      }
    });
    if (exam.sections && exam.sections.length > 0) {
      setActiveSectionId(exam.sections[0].id);
    } else {
      setActiveSectionId(null);
    }
    setSelectedTemplateId(null);
    setIsCreating(true);
    setUploadStatus('IDLE');
    setCsvErrors([]);
  };

  const resetForm = () => {
    setIsCreating(false);
    setShowPreview(false);
    setActiveSectionId(null);
    setSelectedTemplateId(null);
    setNewExam({ 
        title: '', 
        durationMinutes: 60, 
        startTime: Date.now(),
        endTime: Date.now() + 86400000 * 2,
        questions: [],
        sections: [],
        questionCount: 0, 
        shuffleQuestions: true,
        showResults: false,
        reconnectLimit: 1,
        passPercent: 60,
        proctoringConfig: { ...defaultProctoringConfig }, 
        totalMarks: 0,
        assignedStudentIds: [],
        assignedBatchIds: [],
        status: 'DRAFT',
        notificationConfig: {
          enabled: false,
          reminders: { hours24: true, hours1: true },
          customSubject: '',
          customMessage: ''
        }
    });
    setUploadStatus('IDLE');
    setCsvErrors([]);
  };

  const handleDuplicateExam = async (source: Exam) => {
    const makeId = () => Math.random().toString(36).substr(2, 9);
    const now = Date.now();
    const durationMs = (source.durationMinutes || 0) * 60000;
    const windowMs = source.startTime && source.endTime ? Math.max(source.endTime - source.startTime, durationMs) : durationMs;
    const startTime = now + 86400000;
    const endTime = startTime + (windowMs || durationMs || 3600000);

    const questionIdMap = new Map<string, string>();
    const sectionIdMap = new Map<string, string>();

    (source.questions || []).forEach(q => questionIdMap.set(q.id, makeId()));
    (source.sections || []).forEach(section => {
      sectionIdMap.set(section.id, makeId());
      (section.questions || []).forEach(q => {
        if (!questionIdMap.has(q.id)) questionIdMap.set(q.id, makeId());
      });
    });

    const clonedSections = (source.sections || []).map((section, idx) => {
      const newSectionId = sectionIdMap.get(section.id) || makeId();
      return {
        ...section,
        id: newSectionId,
        displayOrder: section.displayOrder ?? idx,
        questions: (section.questions || []).map(q => ({
          ...q,
          id: questionIdMap.get(q.id) || makeId(),
          sectionId: newSectionId
        }))
      };
    });

    const clonedQuestions = clonedSections.length > 0
      ? clonedSections.flatMap(section => section.questions.map(q => ({ ...q, sectionId: section.id })))
      : (source.questions || []).map(q => ({
          ...q,
          id: questionIdMap.get(q.id) || makeId()
        }));

    const payload: Exam = {
      ...source,
      id: makeId(),
      title: `Copy of ${source.title}`,
      status: 'DRAFT',
      startTime,
      endTime,
      questions: clonedQuestions,
      sections: clonedSections,
      totalMarks: clonedQuestions.reduce((sum, q) => sum + (q.marks || 0), 0),
      assignedStudentIds: [],
      assignedBatchIds: [],
      notificationConfig: {
        ...(source.notificationConfig || {}),
        enabled: false
      }
    };

    try {
      const result = await apiPost<{ exam: Exam }>('exams.php', { exam: payload });
      const savedExam = result.exam || payload;
      onUpdateExams(prev => [savedExam, ...prev]);
    } catch (e) {
      console.error(e);
      alert('Failed to duplicate exam.');
    }
  };

  const handleDeleteExam = (exam: Exam) => {
    setDeleteTarget(exam);
  };

  const handleArchiveExam = async () => {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    const archivedExam: Exam = {
      ...deleteTarget,
      status: 'ARCHIVED',
    };
    try {
      await apiPost<{ exam: Exam }>('exams.php', { exam: archivedExam });
      onUpdateExams(prev => prev.filter(e => e.id !== deleteTarget.id));
    } catch (e) {
      console.error('Failed to archive exam:', e);
      alert('Failed to archive exam. Please try again.');
    } finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
    }
  };

  const handlePermanentDeleteExam = async () => {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await apiPost('exams.php', { action: 'DELETE', id: deleteTarget.id, permanent: true });
      onUpdateExams(prev => prev.filter(e => e.id !== deleteTarget.id));
    } catch (e) {
      console.error('Failed to delete exam permanently:', e);
      alert('Failed to delete exam permanently. Please try again.');
    } finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
    }
  };

  // --- Email System Logic ---
  const handleSendEmail = async (exam: Exam) => {
    // 1. Calculate Recipients
    const recipientCount = (exam.assignedStudentIds && exam.assignedStudentIds.length > 0)
      ? exam.assignedStudentIds.length
      : students.length;

    if (!confirm(`Are you sure you want to send exam invitations to ${recipientCount} students?`)) {
        return;
    }

    // 2. Simulate Sending State
    setEmailSendingId(exam.id);

    try {
        const targetStudents = (exam.assignedStudentIds && exam.assignedStudentIds.length > 0)
          ? students.filter(s => exam.assignedStudentIds?.includes(s.id))
          : students;

        const companyId = getAdminCompanyId();
        const messages = targetStudents.map(student => {
          const payload = JSON.stringify({ eid: exam.id, sid: student.id, cid: companyId });
          const token = btoa(payload);
          const link = `${window.location.origin}?token=${token}`;

          const subjectTpl = exam.notificationConfig?.customSubject || `Reminder: ${exam.title}`;
          const messageTpl = exam.notificationConfig?.customMessage
            || "Hello {StudentName},\n\nThis is a reminder for your upcoming exam: {ExamTitle}.\nIt is scheduled to start at {StartTime}.\n\nLink: {Link}\n\nPlease ensure your system is ready.";

          const subject = subjectTpl
            .replace('{StudentName}', student.fullName)
            .replace('{ExamTitle}', exam.title);

          const body = messageTpl
            .replace('{StudentName}', student.fullName)
            .replace('{ExamTitle}', exam.title)
            .replace('{StartTime}', new Date(exam.startTime).toLocaleString())
            .replace('{Link}', link);

          return { to: student.email, subject, body };
        });

        const result = await apiPost<{ sent: number; failed?: { to: string; error: string }[] }>('notify.php', { messages });

        if (result.failed && result.failed.length > 0) {
          alert(`Sent ${result.sent} emails. Failed: ${result.failed.length}. Check server response for details.`);
        } else {
          alert(`Success! Invitations sent to ${result.sent} students.`);
        }
    } catch (e) {
        console.error(e);
        alert("Failed to send emails. Please try again.");
    } finally {
        setEmailSendingId(null);
    }
  };

  // --- Link Generation & Export ---
  const handleExportLinks = (exam: Exam) => {
    // CSV Header
    const csvRows = [
      ["Student Name", "Registration ID", "Email", "Exam Link", "Valid From", "Valid Until"]
    ];

    // Filter students: If assigned IDs exist, use them. Otherwise default to ALL students.
    const targetStudents = (exam.assignedStudentIds && exam.assignedStudentIds.length > 0)
      ? students.filter(s => exam.assignedStudentIds?.includes(s.id))
      : students;

    const companyId = getAdminCompanyId();
    targetStudents.forEach(student => {
      // Create a secure token
      const payload = JSON.stringify({ eid: exam.id, sid: student.id, cid: companyId });
      const token = btoa(payload);
      const link = `${window.location.origin}?token=${token}`;
      
      csvRows.push([
        `"${student.fullName}"`,
        `"${student.registrationId}"`,
        `"${student.email}"`,
        `"${link}"`,
        `"${new Date(exam.startTime).toLocaleString()}"`,
        `"${new Date(exam.endTime).toLocaleString()}"`
      ]);
    });

    const csvContent = "data:text/csv;charset=utf-8," + "\uFEFF" + csvRows.map(e => e.join(",")).join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `${exam.title.replace(/\s+/g, '_')}_Links.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // --- Bulk Upload Logic (Questions) ---
  const downloadTemplate = () => {
    const headers = "Type (MCQ/TEXT),Question Text,Option A,Option B,Option C,Option D,Correct Option (1-4),Marks\n";
    const sampleMCQ = "MCQ,\"What is the capital of France, globally?\",Berlin,London,Paris,Madrid,3,5\n";
    const sampleText = "TEXT,\"Explain the concept of recursion in your own words.\",,,,0,10";
    const csvContent = "data:text/csv;charset=utf-8," + "\uFEFF" + headers + sampleMCQ + sampleText;
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "exam_questions_template.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Robust CSV Line Parser (Handles quoted strings containing commas)
  const parseCSVLine = (text: string): string[] => {
    const result: string[] = [];
    let start = 0;
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') { 
        inQuotes = !inQuotes; 
      } else if (text[i] === ',' && !inQuotes) {
        let field = text.substring(start, i).trim();
        // Remove surrounding quotes and unescape double quotes
        if (field.startsWith('"') && field.endsWith('"')) {
          field = field.slice(1, -1).replace(/""/g, '"');
        }
        result.push(field);
        start = i + 1;
      }
    }
    // Push last field
    let lastField = text.substring(start).trim();
    if (lastField.startsWith('"') && lastField.endsWith('"')) {
      lastField = lastField.slice(1, -1).replace(/""/g, '"');
    }
    result.push(lastField);
    return result;
  };

  const downloadStudentTemplate = () => {
    const headers = 'Full Name,Email,Registration ID\n';
    const sample = '"Ada Lovelace",ada@example.com,REG-1001\n';
    const csvContent = 'data:text/csv;charset=utf-8,' + '\uFEFF' + headers + sample;
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', 'exam_students_template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const parseCSV = (text: string) => {
    const lines = text.split('\n');
    const questions: Question[] = [];
    const errors: CsvError[] = [];

    // Skip header row (index 0)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = parseCSVLine(line);
      
      // Basic structure validation
      if (cols.length < 8) {
        errors.push({ row: i + 1, message: `Insufficient columns. Expected 8, got ${cols.length}.`, rawData: line });
        continue;
      }

      const [typeRaw, qText, optA, optB, optC, optD, correctStr, marksStr] = cols;
      const type = typeRaw.toUpperCase();
      const marks = parseInt(marksStr);

      // Validate Marks
      if (isNaN(marks) || marks <= 0) {
        errors.push({ row: i + 1, message: "Invalid marks. Must be a positive number.", rawData: line });
        continue;
      }

      // Validate Question Text
      if (!qText) {
        errors.push({ row: i + 1, message: "Question text is empty.", rawData: line });
        continue;
      }

      if (type === 'MCQ') {
        const correctVal = parseInt(correctStr);
        if (!optA || !optB || !optC || !optD) {
          errors.push({ row: i + 1, message: "MCQ requires all 4 options to be filled.", rawData: line });
          continue;
        }
        if (isNaN(correctVal) || correctVal < 1 || correctVal > 4) {
          errors.push({ row: i + 1, message: "Correct Option must be between 1 and 4 for MCQ.", rawData: line });
          continue;
        }

        questions.push({
          id: Math.random().toString(36).substr(2, 9),
          text: qText,
          type: QuestionType.MCQ,
          options: [optA, optB, optC, optD],
          correctOptionIndex: correctVal - 1, // Convert 1-based to 0-based
          marks: marks
        });

      } else if (type === 'TEXT') {
        questions.push({
          id: Math.random().toString(36).substr(2, 9),
          text: qText,
          type: QuestionType.TEXT,
          marks: marks
        });
      } else {
        errors.push({ row: i + 1, message: `Invalid Type "${type}". Must be MCQ or TEXT.`, rawData: line });
      }
    }

    return { questions, errors };
  };

  const parseStudentCsv = (text: string) => {
    const lines = text.split('\n');
    const rows: { fullName: string; email: string; registrationId: string }[] = [];
    const errors: string[] = [];

    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const cols = parseCSVLine(trimmed);
      if (idx === 0) {
        const header = cols.join(' ').toLowerCase();
        if (header.includes('email') && header.includes('name')) return;
      }

      if (cols.length < 3) {
        errors.push(`Row ${idx + 1}: expected 3 columns (Full Name, Email, Registration ID).`);
        return;
      }

      const fullName = cols[0]?.trim() || '';
      const email = cols[1]?.trim() || '';
      const registrationId = cols[2]?.trim() || '';

      if (!fullName || !email || !registrationId) {
        errors.push(`Row ${idx + 1}: missing full name, email, or registration ID.`);
        return;
      }

      rows.push({ fullName, email, registrationId });
    });

    return { rows, errors };
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUploadStatus('IDLE');
    setCsvErrors([]);
    setUploadMsg('');
    
    const file = e.target.files?.[0];
    if (!file) return;

    readTextFile(file).then((text) => {
      const { questions, errors } = parseCSV(text);

      setCsvErrors(errors);

      if (questions.length > 0) {
        const targetSectionId = useSections ? (activeSectionId || sections[0]?.id) : undefined;
        const assignedQuestions = targetSectionId
          ? questions.map(q => ({ ...q, sectionId: targetSectionId }))
          : questions;
        setNewExam(prev => ({
          ...prev,
          questions: [...(prev.questions || []), ...assignedQuestions]
        }));

        if (errors.length === 0) {
          setUploadStatus('SUCCESS');
          setUploadMsg(`Successfully added ${questions.length} questions.`);
        } else {
          setUploadStatus('PARTIAL');
          setUploadMsg(`Added ${questions.length} valid questions. ${errors.length} rows failed.`);
        }
      } else {
        if (errors.length > 0) {
          setUploadStatus('ERROR');
          setUploadMsg("No valid questions found. Please fix the errors below.");
        } else {
           setUploadStatus('ERROR');
           setUploadMsg("File appears empty or invalid.");
        }
      }
    }).catch(() => {
      setUploadStatus('ERROR');
      setUploadMsg('Failed to read file. Please re-save as UTF-8 or Windows-1252.');
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const exportExams = () => {
    const payload = exams.map(exam => ({
      ...exam,
      id: exam.id,
    }));
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `exams_export_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const importExams = async (file: File) => {
    const text = await file.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      alert('Invalid JSON file.');
      return;
    }
    const list = Array.isArray(data) ? data : [data];
    const created: Exam[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const makeId = () => Math.random().toString(36).substr(2, 9);
      const questionMap = new Map<string, string>();
      const sectionMap = new Map<string, string>();

      const sourceQuestions: Question[] = Array.isArray(raw.questions) ? raw.questions : [];
      sourceQuestions.forEach(q => {
        if (!q?.id) return;
        questionMap.set(q.id, makeId());
      });

      const sourceSections = Array.isArray(raw.sections) ? raw.sections : [];
      sourceSections.forEach((section: any) => {
        if (!section?.id) return;
        sectionMap.set(section.id, makeId());
        if (Array.isArray(section.questions)) {
          section.questions.forEach((q: any) => {
            if (q?.id && !questionMap.has(q.id)) {
              questionMap.set(q.id, makeId());
            }
          });
        }
      });

      const mappedQuestions = sourceQuestions.map(q => ({
        ...q,
        id: q.id && questionMap.has(q.id) ? questionMap.get(q.id) : makeId(),
        sectionId: q.sectionId && sectionMap.has(q.sectionId) ? sectionMap.get(q.sectionId) : undefined
      }));

      const mappedSections = sourceSections.map((section: any, idx: number) => ({
        ...section,
        id: section.id && sectionMap.has(section.id) ? sectionMap.get(section.id) : makeId(),
        displayOrder: section.displayOrder ?? idx,
        questions: Array.isArray(section.questions)
          ? section.questions.map((q: any) => ({
              ...q,
              id: q.id && questionMap.has(q.id) ? questionMap.get(q.id) : makeId()
            }))
          : []
      }));

      const payload: Exam = {
        ...(raw as Exam),
        id: makeId(),
        status: 'DRAFT',
        questions: mappedQuestions,
        sections: mappedSections,
        totalMarks: mappedQuestions.reduce((sum, q) => sum + (q.marks || 0), 0)
      };

      try {
        const result = await apiPost<{ exam: Exam }>('exams.php', { exam: payload });
        if (result.exam) {
          created.push(result.exam);
        }
      } catch (e) {
        console.error('Failed to import exam', e);
      }
    }
    if (created.length > 0) {
      onUpdateExams(prev => [...created, ...prev]);
      alert(`Imported ${created.length} exams.`);
    } else {
      alert('No exams imported.');
    }
  };

  // --- Batch Student Upload Logic ---
  const handleBatchStudentUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    readTextFile(file).then((text) => {
      const lines = text.split('\n');
      const foundIds: string[] = [];
      let notFoundCount = 0;

      // Extract emails/IDs from all lines (skipping header roughly)
      lines.forEach((line, idx) => {
         const cleanLine = line.trim().replace(/^"|"$/g, '');
         if (!cleanLine || (idx === 0 && (cleanLine.toLowerCase().includes('email') || cleanLine.toLowerCase().includes('id')))) return;
         
         // Try to find by Email OR Registration ID
         const student = students.find(s => s.email === cleanLine || s.registrationId === cleanLine);
         if (student) {
            foundIds.push(student.id);
         } else {
            // Also try comma separated?
            const parts = cleanLine.split(',');
            const match = students.find(s => parts.some(p => p.trim() === s.email || p.trim() === s.registrationId));
            if (match) {
                foundIds.push(match.id);
            } else {
                notFoundCount++;
            }
         }
      });

      // Merge with existing
      const newAssignment = Array.from(new Set([...(newExam.assignedStudentIds || []), ...foundIds]));
      
      setNewExam(prev => ({ ...prev, assignedStudentIds: newAssignment }));
      alert(`Batch Assignment Complete:\n- ${foundIds.length} students matched and selected.\n- ${notFoundCount} rows did not match existing students.`);
    }).catch(() => {
      alert('Failed to read file. Please re-save as UTF-8 or Windows-1252.');
    });
    if (studentBatchInputRef.current) studentBatchInputRef.current.value = '';
  };

  const handleStudentCreateUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    readTextFile(file).then(async (text) => {
      const { rows, errors } = parseStudentCsv(text);

      if (rows.length === 0) {
        alert(`No valid student rows found.${errors.length ? `\n${errors.join('\n')}` : ''}`);
        return;
      }

      const existingMap = new Map<string, Student>();
      students.forEach(s => {
        existingMap.set(s.email.toLowerCase(), s);
        existingMap.set(s.registrationId.toLowerCase(), s);
      });

      const toCreate: { fullName: string; email: string; registrationId: string }[] = [];
      const existingIds: string[] = [];
      const seen = new Set<string>();

      rows.forEach(row => {
        const key = `${row.email.toLowerCase()}|${row.registrationId.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);

        const byEmail = existingMap.get(row.email.toLowerCase());
        const byReg = existingMap.get(row.registrationId.toLowerCase());
        const existing = byEmail || byReg;
        if (existing) {
          existingIds.push(existing.id);
        } else {
          toCreate.push(row);
        }
      });

      let created: Student[] = [];
      let createErrors: string[] = [];
      if (toCreate.length > 0) {
        try {
          const result = await apiPost<{ students: Student[]; errors?: string[] }>('students.php', {
            students: toCreate,
            actor: 'Admin'
          });
          created = result.students || [];
          createErrors = result.errors || [];
        } catch (err) {
          console.error('Failed to create students:', err);
          createErrors.push('Failed to create some students. Check server logs.');
        }
      }

      const createdIds = created.map(s => s.id);
      const mergedAssigned = Array.from(new Set([...(newExam.assignedStudentIds || []), ...existingIds, ...createdIds]));
      setNewExam(prev => ({ ...prev, assignedStudentIds: mergedAssigned }));

      if (created.length > 0 && onUpdateStudents) {
        onUpdateStudents(prev => {
          const byId = new Map(prev.map(s => [s.id, s]));
          created.forEach(s => byId.set(s.id, s));
          return Array.from(byId.values());
        });
      }

      const summary = [
        `Created: ${created.length}`,
        `Matched existing: ${existingIds.length}`,
        `Assigned to this exam: ${existingIds.length + created.length}`,
      ];
      if (errors.length > 0) summary.push(`Skipped rows: ${errors.length}`);
      if (createErrors.length > 0) summary.push(`Create errors: ${createErrors.length}`);
      alert(summary.join('\n'));
    }).catch(() => {
      alert('Failed to read file. Please re-save as UTF-8 or Windows-1252.');
    });
    if (studentCreateInputRef.current) studentCreateInputRef.current.value = '';
  };


  if (isCreating) {
    // PREVIEW MODE RENDER
    if (showPreview) {
        const previewSections = useSections
            ? sections.map((section, idx) => ({
                id: section.id,
                title: section.title,
                displayOrder: idx,
                questionLimit: section.questionLimit ?? 0,
                shuffleQuestions: section.shuffleQuestions ?? true,
                timeLimitMinutes: section.timeLimitMinutes ?? 0,
                lockOnComplete: section.lockOnComplete ?? true,
                questions: (newExam.questions || []).filter(q => q.sectionId === section.id)
              }))
            : [];
        const previewExam = {
            ...newExam,
            id: newExam.id || 'PREVIEW-ID',
            totalMarks: newExam.questions?.reduce((sum, q) => sum + q.marks, 0) || 0,
            startTime: Date.now(),
            endTime: Date.now() + 3600000,
            status: 'PUBLISHED',
            questions: newExam.questions || [],
            sections: previewSections,
            proctoringConfig: newExam.proctoringConfig || {
              cameraRequired: false,
              microphoneRequired: false,
              fullScreenEnforced: false,
              tabSwitchLimit: 3,
              violationLimits: { ...defaultViolationLimits }
            }
        } as Exam;
        
        const previewStudent: Student = {
            id: 'ADMIN-PREVIEW',
            fullName: 'Administrator Preview',
            email: 'admin@proctorguard.com',
            registrationId: 'ADMIN'
        };

        return (
            <div className="fixed inset-0 z-[100] bg-white">
                <div className="absolute top-4 right-20 z-[110]">
                    <div className="bg-amber-100 text-amber-800 px-4 py-2 rounded-full font-bold text-sm border border-amber-200 shadow-sm flex items-center gap-2">
                       <Eye size={16} /> Admin Preview Mode
                    </div>
                </div>
                <div className="absolute top-4 right-4 z-[110]">
                    <button 
                       onClick={() => setShowPreview(false)}
                       className="bg-gray-900 text-white p-2 rounded-full hover:bg-gray-700 shadow-lg transition-colors"
                       title="Exit Preview"
                    >
                       <XCircle size={24} />
                    </button>
                </div>
                <ExamTake 
                    exam={previewExam} 
                    student={previewStudent} 
                    onFinish={() => {
                        alert("Preview Finished. In a real session, results would be submitted.");
                        setShowPreview(false);
                    }} 
                />
            </div>
        );
    }

    const isPublished = newExam.status === 'PUBLISHED';
    const violationLimits = {
      ...defaultViolationLimits,
      ...(newExam.proctoringConfig?.violationLimits || {})
    };

    return (
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="lsc-title">{newExam.id ? 'Edit Exam' : 'Create New Exam'}</h2>
          <button onClick={resetForm} className="px-4 py-2 lsc-button-ghost text-sm">Cancel</button>
        </div>

        {/* Warning for Published Exams */}
        {isPublished && (
          <div className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-r shadow-sm flex items-start gap-3">
             <AlertCircle className="text-amber-600 mt-0.5 shrink-0" />
             <div>
               <h4 className="font-bold text-amber-800">Restricted Editing Mode</h4>
               <p className="text-sm text-amber-700 mt-1">
                 This exam is <strong>PUBLISHED</strong>. To ensure integrity for students who may be taking the exam:
               </p>
               <ul className="list-disc list-inside text-sm text-amber-700 mt-1 ml-1 space-y-0.5">
                 <li>Question modification (add/edit/delete) is <strong>disabled</strong>.</li>
                 <li>Changes to Duration, Schedule, and Proctoring rules will apply <strong>immediately</strong> to active sessions.</li>
               </ul>
             </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Col: Config */}
          <div className="lg:col-span-1 space-y-6">
            <div className="lsc-panel p-6 space-y-4">
              <h3 className="font-semibold text-gray-800">Exam Details</h3>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                <select 
                  className={`w-full px-3 py-2 border rounded-lg outline-none bg-white font-medium ${
                    newExam.status === 'PUBLISHED' ? 'text-teal-700 border-teal-200 bg-teal-50' :
                    newExam.status === 'DRAFT' ? 'text-orange-700 border-orange-200 bg-orange-50' : 'text-gray-700'
                  }`}
                  value={newExam.status || 'DRAFT'}
                  onChange={e => setNewExam({...newExam, status: e.target.value as any})}
                >
                  <option value="DRAFT">Draft (Editing Allowed)</option>
                  <option value="PUBLISHED">Published (Restricted)</option>
                  <option value="ARCHIVED">Archived</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input 
                  type="text" 
                  className="w-full px-3 py-2 border rounded-lg outline-none"
                  value={newExam.title}
                  onChange={e => setNewExam({...newExam, title: e.target.value})}
                  placeholder="e.g. Advanced React Pattern"
                />
              </div>
              
              {/* Schedule */}
              <div className="grid grid-cols-1 gap-4">
                 <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1">
                        <Calendar size={14} /> Start Time
                    </label>
                    <input 
                      type="datetime-local"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={toLocalISOString(new Date(newExam.startTime!))}
                      onChange={e => setNewExam({...newExam, startTime: new Date(e.target.value).getTime()})}
                    />
                 </div>
                 <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1">
                        <Calendar size={14} /> End Time
                    </label>
                    <input 
                      type="datetime-local"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={toLocalISOString(new Date(newExam.endTime!))}
                      onChange={e => setNewExam({...newExam, endTime: new Date(e.target.value).getTime()})}
                    />
                 </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1">
                    <Clock size={14} /> Duration (mins)
                </label>
                <input 
                  type="number" 
                  className="w-full px-3 py-2 border rounded-lg outline-none"
                  value={newExam.durationMinutes}
                  onChange={e => setNewExam({...newExam, durationMinutes: Number(e.target.value)})}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Results Visibility</label>
                <div className="bg-gray-50 p-3 rounded-lg border border-gray-200">
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                      <div className={`w-9 h-5 rounded-full relative transition-colors ${newExam.showResults ? 'bg-[#3558ff]' : 'bg-gray-300'}`}>
                        <input 
                          type="checkbox" 
                          className="sr-only"
                          checked={newExam.showResults ?? false}
                          onChange={e => setNewExam({...newExam, showResults: e.target.checked})}
                        />
                        <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${newExam.showResults ? 'translate-x-4' : 'translate-x-0'}`}></div>
                      </div>
                      <span>Show results immediately after submission</span>
                  </label>
                  <p className="text-[10px] text-gray-500 mt-1 leading-tight">
                    If disabled, students see a thank-you message only.
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Pass Percentage</label>
                <div className="bg-gray-50 p-3 rounded-lg border border-gray-200">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                    value={newExam.passPercent ?? 60}
                    onChange={e => {
                      const next = Math.max(0, Math.min(100, Number(e.target.value)));
                      setNewExam({ ...newExam, passPercent: Number.isNaN(next) ? 60 : next });
                    }}
                  />
                  <p className="text-[10px] text-gray-500 mt-1 leading-tight">
                    Students must score at least this percentage to pass.
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Question Pools / Sections</label>
                <div className="bg-gray-50 p-3 rounded-lg border border-gray-200">
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <div className={`w-9 h-5 rounded-full relative transition-colors ${useSections ? 'bg-[#3558ff]' : 'bg-gray-300'}`}>
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={useSections}
                        onChange={e => (e.target.checked ? enableSections() : disableSections())}
                      />
                      <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${useSections ? 'translate-x-4' : 'translate-x-0'}`}></div>
                    </div>
                    <span>Enable sections with randomized pools</span>
                  </label>
                  <p className="text-[10px] text-gray-500 mt-1 leading-tight">
                    Build sections and pull a randomized subset of questions from each pool.
                  </p>
                </div>

                {useSections && (
                  <div className="mt-3 space-y-3">
                    {sections.map((section, idx) => (
                      <div key={section.id} className={`rounded-lg border p-3 bg-white ${activeSectionId === section.id ? 'border-blue-300 ring-1 ring-blue-200' : 'border-gray-200'}`}>
                        <div className="flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => setActiveSectionId(section.id)}
                            className={`text-xs font-semibold px-2 py-1 rounded ${activeSectionId === section.id ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}
                          >
                            {activeSectionId === section.id ? 'Active' : 'Set Active'}
                          </button>
                          <div className="text-[10px] text-gray-400">
                            {getSectionQuestionCount(section.id)} questions
                          </div>
                        </div>
                        <div className="mt-2 grid grid-cols-1 gap-2">
                          <input
                            type="text"
                            className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                            value={section.title}
                            onChange={e => {
                              const updated = sections.map(s => s.id === section.id ? { ...s, title: e.target.value } : s);
                              setNewExam({ ...newExam, sections: updated });
                            }}
                            placeholder={`Section ${idx + 1}`}
                          />
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[10px] text-gray-500 mb-1">Question Limit</label>
                              <input
                                type="number"
                                min="0"
                                className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                                value={section.questionLimit ?? 0}
                                onChange={e => {
                                  const updated = sections.map(s => s.id === section.id ? { ...s, questionLimit: Math.max(0, Number(e.target.value)) } : s);
                                  setNewExam({ ...newExam, sections: updated });
                                }}
                              />
                              <p className="text-[10px] text-gray-400 mt-1">0 means all questions in this section.</p>
                            </div>
                            <div>
                              <label className="block text-[10px] text-gray-500 mb-1">Shuffle Questions</label>
                              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                                <div className={`w-9 h-5 rounded-full relative transition-colors ${section.shuffleQuestions ? 'bg-[#3558ff]' : 'bg-gray-300'}`}>
                                  <input
                                    type="checkbox"
                                    className="sr-only"
                                    checked={section.shuffleQuestions ?? true}
                                    onChange={e => {
                                      const updated = sections.map(s => s.id === section.id ? { ...s, shuffleQuestions: e.target.checked } : s);
                                      setNewExam({ ...newExam, sections: updated });
                                    }}
                                  />
                                  <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${section.shuffleQuestions ? 'translate-x-4' : 'translate-x-0'}`}></div>
                                </div>
                                <span className="text-xs">Randomize order</span>
                              </label>
                            </div>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[10px] text-gray-500 mb-1">Section Time (mins)</label>
                              <input
                                type="number"
                                min="0"
                                className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                                value={section.timeLimitMinutes ?? 0}
                                onChange={e => {
                                  const updated = sections.map(s => s.id === section.id ? { ...s, timeLimitMinutes: Math.max(0, Number(e.target.value)) } : s);
                                  setNewExam({ ...newExam, sections: updated });
                                }}
                              />
                              <p className="text-[10px] text-gray-400 mt-1">0 uses the global exam timer.</p>
                            </div>
                            <div>
                              <label className="block text-[10px] text-gray-500 mb-1">Lock On Complete</label>
                              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                                <div className={`w-9 h-5 rounded-full relative transition-colors ${section.lockOnComplete ? 'bg-[#3558ff]' : 'bg-gray-300'}`}>
                                  <input
                                    type="checkbox"
                                    className="sr-only"
                                    checked={section.lockOnComplete ?? true}
                                    onChange={e => {
                                      const updated = sections.map(s => s.id === section.id ? { ...s, lockOnComplete: e.target.checked } : s);
                                      setNewExam({ ...newExam, sections: updated });
                                    }}
                                  />
                                  <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${section.lockOnComplete ? 'translate-x-4' : 'translate-x-0'}`}></div>
                                </div>
                                <span className="text-xs">Lock previous section</span>
                              </label>
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 flex justify-between items-center text-[10px] text-gray-400">
                          <span>Section {idx + 1}</span>
                          {sections.length > 1 && (
                            <button
                              type="button"
                              onClick={() => {
                                const remaining = sections.filter(s => s.id !== section.id);
                                const fallbackId = remaining[0]?.id;
                                setNewExam(prev => ({
                                  ...prev,
                                  sections: remaining,
                                  questions: (prev.questions || []).map(q => q.sectionId === section.id ? { ...q, sectionId: fallbackId } : q)
                                }));
                                if (activeSectionId === section.id) {
                                  setActiveSectionId(fallbackId || null);
                                }
                              }}
                              className="text-[10px] text-rose-600 hover:underline"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        const next = createSection(`Section ${sections.length + 1}`, sections.length);
                        setNewExam(prev => ({ ...prev, sections: [...(prev.sections || []), next] }));
                        setActiveSectionId(next.id);
                      }}
                      className="w-full py-2 border border-dashed border-blue-300 text-blue-600 rounded-lg text-sm hover:bg-blue-50"
                    >
                      Add Section
                    </button>
                    {activeSectionId && (
                      <div className="text-[10px] text-gray-400">
                        New questions will be added to: {sections.find(s => s.id === activeSectionId)?.title || 'Section'}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Question Limit & Shuffling */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-1">
                    <ListOrdered size={14} /> Question Order & Limits
                </label>
                
                <div className="bg-gray-50 p-3 rounded-lg border border-gray-200 space-y-3">
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                      <div className={`w-9 h-5 rounded-full relative transition-colors ${newExam.shuffleQuestions ? 'bg-[#3558ff]' : 'bg-gray-300'} ${useSections ? 'opacity-50' : ''}`}>
                        <input 
                          type="checkbox" 
                          className="sr-only"
                          checked={newExam.shuffleQuestions ?? true}
                          onChange={e => !useSections && setNewExam({...newExam, shuffleQuestions: e.target.checked})}
                          disabled={useSections}
                        />
                        <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${newExam.shuffleQuestions ? 'translate-x-4' : 'translate-x-0'}`}></div>
                      </div>
                      <span className="flex items-center gap-1.5">
                        <Shuffle size={14} className={newExam.shuffleQuestions ? 'text-blue-600' : 'text-gray-400'} />
                        Randomize Order
                      </span>
                  </label>

                  <div>
                     <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-gray-600">Question Subset Limit</span>
                        <span className="text-xs text-gray-400">{newExam.questionCount === 0 ? 'All' : newExam.questionCount} / {newExam.questions?.length || 0}</span>
                     </div>
                     <input 
                      type="number" 
                      min="0"
                      max={newExam.questions?.length}
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={newExam.questionCount}
                      onChange={e => !useSections && setNewExam({...newExam, questionCount: Number(e.target.value)})}
                      disabled={useSections}
                      placeholder="0 for all"
                     />
                     <p className="text-[10px] text-gray-500 mt-1 leading-tight">
                        {useSections
                          ? 'Section settings override global question limits.'
                          : newExam.questionCount === 0 
                            ? `Students see all ${newExam.questions?.length || 0} questions.` 
                            : `Students see ${newExam.questionCount} questions selected ${newExam.shuffleQuestions ? 'randomly' : 'sequentially'} from the pool.`}
                     </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="lsc-panel p-6 space-y-4">
              <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
                Proctoring Rules
              </h3>
              <div className="space-y-4">
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={newExam.proctoringConfig?.cameraRequired} onChange={e => setNewExam({...newExam, proctoringConfig: {...newExam.proctoringConfig!, cameraRequired: e.target.checked}})} />
                  Require Camera
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={newExam.proctoringConfig?.microphoneRequired} onChange={e => setNewExam({...newExam, proctoringConfig: {...newExam.proctoringConfig!, microphoneRequired: e.target.checked}})} />
                  Require Microphone
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={newExam.proctoringConfig?.fullScreenEnforced} onChange={e => setNewExam({...newExam, proctoringConfig: {...newExam.proctoringConfig!, fullScreenEnforced: e.target.checked}})} />
                  Enforce Fullscreen
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm text-gray-700 font-medium block mb-1">Reconnect Attempts</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={newExam.reconnectLimit ?? 0}
                      onChange={e => setNewExam({ ...newExam, reconnectLimit: Math.max(0, Number(e.target.value)) })}
                    />
                    <p className="text-[10px] text-gray-500 mt-1">
                      Number of times a student can reconnect to an active session after disconnect.
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-gray-700 font-medium block mb-1">Tab Switch Limit</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={newExam.proctoringConfig?.tabSwitchLimit ?? 0}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          tabSwitchLimit: Math.max(0, Number(e.target.value))
                        }
                      })}
                    />
                    <p className="text-[10px] text-gray-500 mt-1">
                      Kicks the student after this many tab switches. Use 0 to disable.
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-gray-700 font-medium block mb-1">Camera Violation Limit</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={violationLimits.camera}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          violationLimits: {
                            ...violationLimits,
                            camera: Math.max(0, Number(e.target.value))
                          }
                        }
                      })}
                    />
                    <p className="text-[10px] text-gray-500 mt-1">
                      Counts camera-related alerts (no face, multiple faces, phone, suspicious object).
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-gray-700 font-medium block mb-1">Microphone Violation Limit</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={violationLimits.microphone}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          violationLimits: {
                            ...violationLimits,
                            microphone: Math.max(0, Number(e.target.value))
                          }
                        }
                      })}
                    />
                    <p className="text-[10px] text-gray-500 mt-1">
                      Counts speech or strong microphone violations. Mild background noise is tolerated. Use 0 to disable.
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-gray-700 font-medium block mb-1">Fullscreen Exit Limit</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={violationLimits.fullscreen}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          violationLimits: {
                            ...violationLimits,
                            fullscreen: Math.max(0, Number(e.target.value))
                          }
                        }
                      })}
                    />
                    <p className="text-[10px] text-gray-500 mt-1">
                      Auto-kick after this many fullscreen exits. Use 0 to disable.
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-gray-700 font-medium block mb-1">Copy/Paste Limit</label>
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border rounded-lg outline-none text-sm"
                      value={violationLimits.copyPaste}
                      onChange={e => setNewExam({
                        ...newExam,
                        proctoringConfig: {
                          ...newExam.proctoringConfig!,
                          violationLimits: {
                            ...violationLimits,
                            copyPaste: Math.max(0, Number(e.target.value))
                          }
                        }
                      })}
                    />
                    <p className="text-[10px] text-gray-500 mt-1">
                      Auto-kick after this many copy/paste attempts. Use 0 to disable.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Student Assignment */}
            <div className="lsc-panel p-6 space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                  <Users size={16} /> Assign Batches
                </h3>
                <div className="text-xs text-gray-500">
                  {(newExam.assignedBatchIds || []).length} batches selected
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3 text-[11px] text-gray-500 leading-snug">
                <p>
                  <span className="font-semibold text-gray-700">Batch-Based Assignment:</span> Select one or more batches and everyone in those batches will be assigned to the exam automatically.
                </p>
                <p>
                  <span className="font-semibold text-gray-700">Company Scope:</span> Only batches under the current authenticated company are shown here.
                </p>
                <p>
                  <span className="font-semibold text-gray-700">Auto Expansion:</span> Selected batches are expanded to student IDs automatically when the exam is saved.
                </p>
              </div>
              
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 text-gray-400" size={14} />
                <input 
                  type="text" 
                  placeholder="Search batches..." 
                  className="w-full pl-8 pr-3 py-2 text-sm border rounded-lg outline-none"
                  value={batchSearch}
                  onChange={e => setBatchSearch(e.target.value)}
                />
              </div>
              <div className="max-h-48 overflow-y-auto border rounded-lg divide-y divide-gray-50">
                {batches
                  .filter(batch => batch.name.toLowerCase().includes(batchSearch.toLowerCase()) || (batch.description || '').toLowerCase().includes(batchSearch.toLowerCase()))
                  .map(batch => (
                  <label key={batch.id} className="flex items-center gap-3 p-3 hover:bg-gray-50 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={(newExam.assignedBatchIds || []).includes(batch.id)}
                      onChange={() => toggleBatch(batch.id)}
                      className="rounded text-blue-600"
                    />
                    <div className="text-sm">
                       <div className="font-medium text-gray-900">{batch.name}</div>
                       <div className="text-xs text-gray-500">
                         {typeof batch.studentCount === 'number' ? `${batch.studentCount} students` : `${students.filter(student => student.batchId === batch.id).length} students`}
                         {batch.description ? ` • ${batch.description}` : ''}
                       </div>
                    </div>
                  </label>
                ))}
                {batches.length === 0 && <div className="p-3 text-xs text-gray-400 text-center">No batches found. Create batches in Student Registry first.</div>}
              </div>
              <div className="text-xs text-gray-500 text-right">
                {getStudentIdsForBatchIds(newExam.assignedBatchIds || []).length} students will receive this exam
              </div>
            </div>
            
            {/* Email Notifications Config */}
            <div className="lsc-panel p-6 space-y-4">
                <div className="flex justify-between items-start">
                    <div>
                        <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                            <Bell size={16} /> Email Notifications
                        </h3>
                        <p className="text-xs text-gray-500 mt-1">Configure automated reminders sent to students.</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                        <input 
                            type="checkbox" 
                            className="sr-only peer"
                            checked={newExam.notificationConfig?.enabled ?? false}
                            onChange={e => setNewExam({
                                ...newExam, 
                                notificationConfig: {
                                    enabled: e.target.checked,
                                    reminders: newExam.notificationConfig?.reminders || { hours24: true, hours1: true },
                                    customSubject: newExam.notificationConfig?.customSubject || `Reminder: ${newExam.title || '{ExamTitle}'}`,
                                    customMessage: newExam.notificationConfig?.customMessage || "Hello {StudentName},\n\nThis is a reminder for your upcoming exam: {ExamTitle}.\nIt is scheduled to start at {StartTime}.\n\nPlease ensure your system is ready.\n\nGood luck!"
                                }
                            })}
                        />
                        <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#3558ff]"></div>
                    </label>
                </div>
                
                {newExam.notificationConfig?.enabled && (
                    <div className="space-y-4 animate-in fade-in slide-in-from-top-2 pt-2">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${newExam.notificationConfig.reminders.hours24 ? 'bg-blue-50 border-blue-200' : 'bg-gray-50 border-gray-100 hover:bg-gray-100'}`}>
                                <input 
                                    type="checkbox" 
                                    className="w-4 h-4 text-blue-600 rounded"
                                    checked={newExam.notificationConfig.reminders.hours24}
                                    onChange={e => setNewExam({
                                        ...newExam,
                                        notificationConfig: {
                                            ...newExam.notificationConfig!,
                                            reminders: { ...newExam.notificationConfig!.reminders, hours24: e.target.checked }
                                        }
                                    })}
                                />
                                <span className="text-sm font-medium text-gray-700">24 Hours Before</span>
                            </label>
                            <label className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${newExam.notificationConfig.reminders.hours1 ? 'bg-blue-50 border-blue-200' : 'bg-gray-50 border-gray-100 hover:bg-gray-100'}`}>
                                <input 
                                    type="checkbox" 
                                    className="w-4 h-4 text-blue-600 rounded"
                                    checked={newExam.notificationConfig.reminders.hours1}
                                    onChange={e => setNewExam({
                                        ...newExam,
                                        notificationConfig: {
                                            ...newExam.notificationConfig!,
                                            reminders: { ...newExam.notificationConfig!.reminders, hours1: e.target.checked }
                                        }
                                    })}
                                />
                                <span className="text-sm font-medium text-gray-700">1 Hour Before</span>
                            </label>
                        </div>
                        
                        {templates.length > 0 && (
                          <div className="pt-2">
                            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Use Template</label>
                            <select
                              className="w-full px-3 py-2 border border-gray-200 rounded-lg outline-none text-sm bg-white"
                              value={selectedTemplateId ?? ''}
                              onChange={e => {
                                const val = e.target.value;
                                if (!val) {
                                  setSelectedTemplateId(null);
                                  return;
                                }
                                const tpl = templates.find(t => t.id === Number(val));
                                if (!tpl) return;
                                setSelectedTemplateId(tpl.id);
                                setNewExam({
                                  ...newExam,
                                  notificationConfig: {
                                    ...newExam.notificationConfig!,
                                    customSubject: tpl.subject || newExam.notificationConfig!.customSubject,
                                    customMessage: tpl.body
                                  }
                                });
                              }}
                            >
                              <option value="">Select a template</option>
                              {templates.map(tpl => (
                                <option key={tpl.id} value={tpl.id}>
                                  {tpl.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}

                        <div className="space-y-3 pt-2">
                            <div>
                                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Email Subject</label>
                                <input 
                                    type="text" 
                                    className="w-full px-3 py-2 border border-gray-200 rounded-lg outline-none text-sm transition-shadow"
                                    placeholder="e.g. Reminder: {ExamTitle}"
                                    value={newExam.notificationConfig.customSubject}
                                    onChange={e => setNewExam({
                                        ...newExam,
                                        notificationConfig: {
                                            ...newExam.notificationConfig!,
                                            customSubject: e.target.value
                                        }
                                    })}
                                />
                            </div>
                             <div>
                                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Message Body</label>
                                <textarea 
                                    className="w-full px-3 py-2 border border-gray-200 rounded-lg outline-none text-sm transition-shadow min-h-[120px]"
                                    rows={5}
                                    value={newExam.notificationConfig.customMessage}
                                    onChange={e => setNewExam({
                                        ...newExam,
                                        notificationConfig: {
                                            ...newExam.notificationConfig!,
                                            customMessage: e.target.value
                                        }
                                    })}
                                />
                                <div className="mt-2 flex flex-wrap gap-2">
                                    {['{StudentName}', '{ExamTitle}', '{StartTime}', '{Link}'].map(tag => (
                                        <button 
                                            key={tag}
                                            onClick={() => setNewExam({
                                                ...newExam,
                                                notificationConfig: {
                                                    ...newExam.notificationConfig!,
                                                    customMessage: (newExam.notificationConfig!.customMessage || '') + tag
                                                }
                                            })}
                                            className="px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-600 text-[10px] font-mono rounded border border-gray-200 transition-colors"
                                            title="Click to insert"
                                        >
                                            {tag}
                                        </button>
                                    ))}
                                </div>
                                <p className="text-blue-900 font-bold mt-6 text-lg">{uploadMsg}</p>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <button 
                onClick={() => {
                  if (!newExam.title || !newExam.questions?.length) {
                    alert("Please add a title and at least one question to preview.");
                    return;
                  }
                  setShowPreview(true);
                }}
                disabled={!newExam.title || !newExam.questions?.length}
                className="w-full py-3 bg-white border border-gray-300 text-gray-700 rounded-lg font-semibold hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed flex justify-center items-center gap-2 mb-3 shadow-sm"
            >
                <Eye size={18} />
                Preview Exam
            </button>
            <button 
              onClick={handleSaveExam}
              disabled={!newExam.title || !newExam.questions?.length}
              className="w-full py-3 lsc-button-primary disabled:bg-gray-300 disabled:cursor-not-allowed flex justify-center items-center gap-2"
            >
              <Save size={18} />
              Save Exam
            </button>
          </div>

          {/* Right Col: Questions */}
          <div className="lg:col-span-2 space-y-6">
             <div className={`lsc-panel overflow-hidden relative ${isPublished ? 'opacity-60 grayscale pointer-events-none select-none' : ''}`}>
                
                {isPublished && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-gray-50/20 backdrop-blur-[1px]">
                       <div className="bg-white px-4 py-2 rounded-full shadow-lg border border-gray-200 text-sm font-bold text-gray-500 flex items-center gap-2">
                         <Lock size={16} /> Questions Locked
                       </div>
                    </div>
                )}

                <div className="p-4 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                  <Plus size={18} className="text-gray-500" />
                  <h3 className="font-semibold text-gray-800">Add Questions</h3>
                </div>
                
                <div className="p-6 space-y-8">
                  {/* Manual Entry Form */}
                  <div className="space-y-4">
                     <div className="flex justify-between items-center">
                        <h4 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">Manual Entry</h4>
                        
                        {/* Type Selector */}
                        <div className="flex bg-gray-100 p-1 rounded-lg">
                           <button 
                              onClick={() => setManualQ({...manualQ, type: QuestionType.MCQ})}
                              className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${manualQ.type === QuestionType.MCQ ? 'bg-white shadow text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
                           >
                              <CheckSquare size={14} /> Multiple Choice
                           </button>
                           <button 
                              onClick={() => setManualQ({...manualQ, type: QuestionType.TEXT})}
                              className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${manualQ.type === QuestionType.TEXT ? 'bg-white shadow text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
                           >
                              <AlignLeft size={14} /> Text / Fill-in
                           </button>
                        </div>
                     </div>
                     
                     <div>
                       <label className="block text-sm text-gray-600 mb-1">Question Text</label>
                       <textarea 
                          className="w-full p-3 border rounded-lg outline-none"
                          rows={2}
                          placeholder={manualQ.type === QuestionType.TEXT ? "e.g. The capital of France is _______." : "e.g. What is the complexity of binary search?"}
                          value={manualQ.text}
                          onChange={e => setManualQ({...manualQ, text: e.target.value})}
                       />
                       {manualQ.type === QuestionType.TEXT && (
                           <p className="text-[10px] text-gray-400 mt-1">
                               Tip: You can use dashes (e.g., ----) or underscores (____) to represent blanks.
                           </p>
                       )}
                     </div>
                     
                     {/* Options - Only for MCQ */}
                     {manualQ.type === QuestionType.MCQ && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 animate-in fade-in slide-in-from-top-1">
                            {manualQ.options.map((opt, i) => (
                                <div key={i}>
                                <label className="block text-xs text-gray-500 mb-1">Option {String.fromCharCode(65 + i)}</label>
                                <input 
                                    type="text" 
                                    className="w-full px-3 py-2 border rounded-lg outline-none"
                                    placeholder={`Option ${i+1}`}
                                    value={opt}
                                    onChange={e => updateOption(i, e.target.value)}
                                />
                                </div>
                            ))}
                        </div>
                     )}

                     <div className="flex gap-4">
                       {manualQ.type === QuestionType.MCQ && (
                            <div className="flex-1 animate-in fade-in slide-in-from-top-1">
                                <label className="block text-sm text-gray-600 mb-1">Correct Answer</label>
                                <select 
                                    className="w-full px-3 py-2 border rounded-lg outline-none bg-white"
                                    value={manualQ.correctIdx}
                                    onChange={e => setManualQ({...manualQ, correctIdx: Number(e.target.value)})}
                                >
                                {manualQ.options.map((_, i) => (
                                    <option key={i} value={i}>Option {String.fromCharCode(65 + i)}</option>
                                ))}
                                </select>
                            </div>
                       )}
                       <div className="w-24">
                         <label className="block text-sm text-gray-600 mb-1">Marks</label>
                         <input 
                            type="number" 
                            className="w-full px-3 py-2 border rounded-lg outline-none"
                            min="1"
                            value={manualQ.marks}
                            onChange={e => setManualQ({...manualQ, marks: Number(e.target.value)})}
                         />
                       </div>
                     </div>

                     <button 
                        onClick={handleAddManualQuestion}
                        className="w-full py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors flex justify-center items-center gap-2"
                     >
                       <Plus size={16} /> Add Question
                     </button>
                  </div>

                  <div className="border-t border-gray-100 pt-6">
                    <div className="flex justify-between items-center mb-4">
                       <h4 className="text-sm font-semibold text-gray-600 uppercase tracking-wide flex items-center gap-2">
                         <FileSpreadsheet size={16} /> Bulk Upload (Excel/CSV)
                       </h4>
                       <button 
                         onClick={downloadTemplate}
                         className="text-blue-600 text-sm hover:underline flex items-center gap-1"
                       >
                         <Download size={14} /> Download Template
                       </button>
                    </div>
                    
                    <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 flex flex-col items-center justify-center bg-gray-50 hover:bg-blue-50 hover:border-blue-300 transition-colors cursor-pointer relative">
                      <input 
                        ref={fileInputRef}
                        type="file" 
                        accept=".csv" 
                        className="absolute inset-0 opacity-0 cursor-pointer"
                        onChange={handleFileUpload}
                      />
                      <Upload size={32} className="text-gray-400 mb-2" />
                      <p className="text-sm text-gray-600 font-medium">Click to upload CSV</p>
                    </div>

                    {/* Upload Status Messages */}
                    {uploadStatus === 'SUCCESS' && (
                      <div className="mt-3 p-3 bg-teal-50 text-teal-700 text-sm rounded-lg flex items-center gap-2 border border-teal-100">
                        <CheckCircle size={16} /> {uploadMsg}
                      </div>
                    )}
                    {uploadStatus === 'PARTIAL' && (
                      <div className="mt-3 p-3 bg-orange-50 text-orange-800 text-sm rounded-lg flex items-center gap-2 border border-orange-100">
                        <FileWarning size={16} /> {uploadMsg}
                      </div>
                    )}
                    {uploadStatus === 'ERROR' && (
                      <div className="mt-3 p-3 bg-red-50 text-red-700 text-sm rounded-lg flex items-center gap-2 border border-red-100">
                        <AlertCircle size={16} /> {uploadMsg}
                      </div>
                    )}

                    {/* Detailed Error Report */}
                    {csvErrors.length > 0 && (
                      <div className="mt-4 bg-red-50 rounded-lg border border-red-100 overflow-hidden">
                        <div className="px-4 py-2 bg-red-100 border-b border-red-200 flex items-center gap-2 text-red-800 text-xs font-bold uppercase">
                          <XCircle size={14} /> Failed Rows ({csvErrors.length})
                        </div>
                        <div className="max-h-40 overflow-auto lsc-table-wrap">
                          <table className="w-full text-left text-xs">
                             <thead className="bg-red-100/50 text-red-700">
                               <tr>
                                 <th className="px-4 py-2 w-16">Row</th>
                                 <th className="px-4 py-2">Error</th>
                                 <th className="px-4 py-2 text-gray-500">Raw Data (Truncated)</th>
                               </tr>
                             </thead>
                             <tbody className="divide-y divide-red-100">
                               {csvErrors.map((err, i) => (
                                 <tr key={i} className="hover:bg-red-100/40 transition-colors">
                                   <td className="px-4 py-2 font-mono text-red-600 font-semibold">{err.row}</td>
                                   <td className="px-4 py-2 text-red-800">{err.message}</td>
                                   <td className="px-4 py-2 text-gray-500 font-mono truncate max-w-xs" title={err.rawData}>
                                     {err.rawData.substring(0, 50)}...
                                   </td>
                                 </tr>
                               ))}
                             </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
             </div>

             {/* Question List */}
             <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
               <h3 className="font-semibold text-gray-800 sticky top-0 bg-white/90 backdrop-blur z-10 py-2">
                 Questions ({newExam.questions?.length || 0})
               </h3>
               {newExam.questions?.map((q, idx) => (
                 <div key={q.id} className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm relative group">
                   {!isPublished && (
                     <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                       <button onClick={() => removeQuestion(q.id)} className="text-red-500 hover:bg-red-50 p-1 rounded transition-colors">
                         <Trash2 size={16} />
                       </button>
                     </div>
                   )}
                   <div className="flex gap-3 mb-2">
                     <span className="bg-gray-100 text-gray-600 px-2 py-0.5 rounded text-xs font-mono">Q{idx + 1}</span>
                     <span className="bg-blue-50 text-blue-600 px-2 py-0.5 rounded text-xs font-mono">{q.type}</span>
                     <span className="bg-teal-50 text-teal-600 px-2 py-0.5 rounded text-xs font-mono">{q.marks} marks</span>
                   </div>
                   {useSections && (
                     <div className="flex items-center gap-2 mb-2">
                       <span className="text-[10px] text-gray-500 uppercase tracking-widest">Section</span>
                       <select
                         className="px-2 py-1 border border-gray-200 rounded text-xs bg-white"
                         value={q.sectionId || sections[0]?.id}
                         onChange={e => {
                           const sectionId = e.target.value;
                           setNewExam(prev => ({
                             ...prev,
                             questions: (prev.questions || []).map(item =>
                               item.id === q.id ? { ...item, sectionId } : item
                             )
                           }));
                         }}
                       >
                         {sections.map(section => (
                           <option key={section.id} value={section.id}>
                             {section.title}
                           </option>
                         ))}
                       </select>
                     </div>
                   )}
                   <p className="text-gray-800 font-medium mb-3 whitespace-pre-wrap">{q.text}</p>
                   {q.type === QuestionType.MCQ && (
                     <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                       {q.options?.map((opt, i) => (
                         <div key={i} className={`text-sm p-2 rounded border ${i === q.correctOptionIndex ? 'bg-teal-50 border-teal-200 text-teal-700' : 'bg-gray-50 border-gray-100 text-gray-600'}`}>
                           <span className="font-bold mr-2">{String.fromCharCode(65 + i)}.</span>{opt}
                         </div>
                       ))}
                     </div>
                   )}
                 </div>
               ))}
               
               {newExam.questions?.length === 0 && (
                 <div className="text-center py-8 text-gray-400 border-2 border-dashed border-gray-200 rounded-xl">
                   No questions added yet. Use the manual form or upload a CSV.
                 </div>
               )}
             </div>
          </div>
        </div>
      </div>
    );
  };
  
  // Render List View (Default)
  return (
    <div className="space-y-6">
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border border-slate-200">
            <div className="p-5 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">Remove Exam</h3>
              <p className="text-sm text-slate-600 mt-1">
                Choose how to remove <span className="font-medium text-slate-900">{deleteTarget.title}</span>.
              </p>
            </div>
            <div className="p-5 space-y-3">
              <button
                onClick={handleArchiveExam}
                disabled={deleteBusy}
                className="w-full px-4 py-2.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                Archive (Hide from list)
              </button>
              <button
                onClick={handlePermanentDeleteExam}
                disabled={deleteBusy}
                className="w-full px-4 py-2.5 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-60"
              >
                Delete Permanently
              </button>
              <button
                onClick={() => !deleteBusy && setDeleteTarget(null)}
                disabled={deleteBusy}
                className="w-full px-4 py-2.5 rounded-lg text-slate-500 hover:bg-slate-50 disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="lsc-title">Exam Management</h2>
          <p className="lsc-subtitle mt-1">Create, duplicate, and publish exams with full security controls.</p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <input
            ref={examImportRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) {
                importExams(file);
              }
              if (examImportRef.current) examImportRef.current.value = '';
            }}
          />
          <button
            onClick={() => examImportRef.current?.click()}
            className="px-4 py-2 lsc-button-ghost flex items-center gap-2 text-sm"
          >
            <Upload size={16} /> Import
          </button>
          <button
            onClick={exportExams}
            className="px-4 py-2 lsc-button-ghost flex items-center gap-2 text-sm"
          >
            <Download size={16} /> Export
          </button>
          <button 
            onClick={() => { resetForm(); setIsCreating(true); }}
            className="px-4 py-2 lsc-button-primary flex items-center gap-2"
          >
            <Plus size={20} /> Create Exam
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {exams.map(exam => (
          <div
            key={exam.id}
            onClick={() => handleEditExam(exam)}
            className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow cursor-pointer group"
          >
            <div className="p-5 border-b border-gray-100 relative">
              <div className="flex justify-between items-start mb-2">
                <span className={`px-2 py-1 text-xs font-bold rounded uppercase tracking-wide ${
                  exam.status === 'PUBLISHED' ? 'bg-teal-100 text-teal-700' :
                  exam.status === 'DRAFT' ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-600'
                }`}>
                  {exam.status}
                </span>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleDeleteExam(exam);
                  }}
                  className="p-1 rounded-full text-rose-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                  title="Delete exam"
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <h3 className="font-bold text-gray-800 text-lg truncate" title={exam.title}>{exam.title}</h3>
              <div className="flex items-center gap-4 mt-3 text-sm text-gray-500">
                <div className="flex items-center gap-1"><Clock size={14}/> {exam.durationMinutes}m</div>
                <div className="flex items-center gap-1"><Users size={14}/> {exam.assignedBatchIds?.length ? `${exam.assignedBatchIds.length} batches` : 'All'}</div>
              </div>
            </div>
            <div className="bg-gray-50 px-3 py-2">
              <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleDuplicateExam(exam);
                  }}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/80 text-[11px] sm:text-xs font-medium text-gray-600 hover:text-blue-600 hover:bg-white shadow-xs"
                >
                  <Copy size={12} /> Duplicate
                </button>
                <button 
                  onClick={e => {
                    e.stopPropagation();
                    handleSendEmail(exam);
                  }}
                  disabled={!!emailSendingId}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/80 text-[11px] sm:text-xs font-medium text-gray-600 hover:text-blue-600 hover:bg-white disabled:opacity-50 shadow-xs"
                >
                  {emailSendingId === exam.id ? <Loader2 size={12} className="animate-spin"/> : <Mail size={12} />}
                  Notify
                </button>
                <button 
                  onClick={e => {
                    e.stopPropagation();
                    handleExportLinks(exam);
                  }}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/80 text-[11px] sm:text-xs font-medium text-gray-600 hover:text-blue-600 hover:bg-white shadow-xs"
                >
                  <Share2 size={12} /> Links
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
