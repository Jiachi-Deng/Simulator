import koffi from 'koffi'
import type { LibraryHandle, TypeObject } from 'koffi'
import type {
  ModuleProcess,
  ModuleSpawnRequest,
  ProcessExit,
  WindowsJobProcessFactory,
} from './types.ts'
import { createWindowsEnvironmentBlock } from './windows-environment.ts'

export { createWindowsEnvironmentBlock } from './windows-environment.ts'

const CREATE_SUSPENDED = 0x0000_0004
const CREATE_UNICODE_ENVIRONMENT = 0x0000_0400
const CREATE_NO_WINDOW = 0x0800_0000
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS = 1
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9
const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 258
const RESUME_THREAD_FAILED = 0xffff_ffff

interface Win32Api {
  readonly library: LibraryHandle
  readonly STARTUPINFO: TypeObject
  readonly EXTENDED_LIMIT_INFORMATION: TypeObject
  readonly BASIC_ACCOUNTING_INFORMATION: TypeObject
  readonly CreateJobObjectW: (...args: unknown[]) => unknown
  readonly SetInformationJobObject: (...args: unknown[]) => number
  readonly CreateProcessW: (...args: unknown[]) => number
  readonly AssignProcessToJobObject: (...args: unknown[]) => number
  readonly ResumeThread: (...args: unknown[]) => number
  readonly TerminateJobObject: (...args: unknown[]) => number
  readonly TerminateProcess: (...args: unknown[]) => number
  readonly QueryInformationJobObject: (...args: unknown[]) => number
  readonly WaitForSingleObject: (...args: unknown[]) => number
  readonly GetExitCodeProcess: (...args: unknown[]) => number
  readonly CloseHandle: (...args: unknown[]) => number
  readonly GetLastError: () => number
}

interface ProcessInformation {
  hProcess?: unknown
  hThread?: unknown
  dwProcessId?: number
  dwThreadId?: number
}

let cachedWin32Api: Win32Api | undefined

function createWin32Api(): Win32Api {
  if (process.platform !== 'win32') throw new Error('Windows Job Objects are only available on win32')
  if (cachedWin32Api) return cachedWin32Api

  const kernel32 = koffi.load('kernel32.dll')
  const HANDLE = koffi.pointer('SIMULATOR_HANDLE', koffi.opaque('SIMULATOR_HANDLE_VALUE'))
  const STARTUPINFO = koffi.struct('SIMULATOR_STARTUPINFOW', {
    cb: 'uint32_t',
    lpReserved: 'void *',
    lpDesktop: 'void *',
    lpTitle: 'void *',
    dwX: 'uint32_t',
    dwY: 'uint32_t',
    dwXSize: 'uint32_t',
    dwYSize: 'uint32_t',
    dwXCountChars: 'uint32_t',
    dwYCountChars: 'uint32_t',
    dwFillAttribute: 'uint32_t',
    dwFlags: 'uint32_t',
    wShowWindow: 'uint16_t',
    cbReserved2: 'uint16_t',
    lpReserved2: 'void *',
    hStdInput: HANDLE,
    hStdOutput: HANDLE,
    hStdError: HANDLE,
  })
  const PROCESS_INFORMATION = koffi.struct('SIMULATOR_PROCESS_INFORMATION', {
    hProcess: HANDLE,
    hThread: HANDLE,
    dwProcessId: 'uint32_t',
    dwThreadId: 'uint32_t',
  })
  const BASIC_LIMIT_INFORMATION = koffi.struct('SIMULATOR_JOB_BASIC_LIMIT_INFORMATION', {
    PerProcessUserTimeLimit: 'int64_t',
    PerJobUserTimeLimit: 'int64_t',
    LimitFlags: 'uint32_t',
    MinimumWorkingSetSize: 'uintptr_t',
    MaximumWorkingSetSize: 'uintptr_t',
    ActiveProcessLimit: 'uint32_t',
    Affinity: 'uintptr_t',
    PriorityClass: 'uint32_t',
    SchedulingClass: 'uint32_t',
  })
  const IO_COUNTERS = koffi.struct('SIMULATOR_IO_COUNTERS', {
    ReadOperationCount: 'uint64_t',
    WriteOperationCount: 'uint64_t',
    OtherOperationCount: 'uint64_t',
    ReadTransferCount: 'uint64_t',
    WriteTransferCount: 'uint64_t',
    OtherTransferCount: 'uint64_t',
  })
  const EXTENDED_LIMIT_INFORMATION = koffi.struct('SIMULATOR_JOB_EXTENDED_LIMIT_INFORMATION', {
    BasicLimitInformation: BASIC_LIMIT_INFORMATION,
    IoInfo: IO_COUNTERS,
    ProcessMemoryLimit: 'uintptr_t',
    JobMemoryLimit: 'uintptr_t',
    PeakProcessMemoryUsed: 'uintptr_t',
    PeakJobMemoryUsed: 'uintptr_t',
  })
  const BASIC_ACCOUNTING_INFORMATION = koffi.struct('SIMULATOR_JOB_BASIC_ACCOUNTING_INFORMATION', {
    TotalUserTime: 'int64_t',
    TotalKernelTime: 'int64_t',
    ThisPeriodTotalUserTime: 'int64_t',
    ThisPeriodTotalKernelTime: 'int64_t',
    TotalPageFaultCount: 'uint32_t',
    TotalProcesses: 'uint32_t',
    ActiveProcesses: 'uint32_t',
    TotalTerminatedProcesses: 'uint32_t',
  })

  cachedWin32Api = {
    library: kernel32,
    STARTUPINFO,
    EXTENDED_LIMIT_INFORMATION,
    BASIC_ACCOUNTING_INFORMATION,
    CreateJobObjectW: kernel32.func('void * __stdcall CreateJobObjectW(void *attributes, const char16_t *name)'),
    SetInformationJobObject: kernel32.func(
      '__stdcall',
      'SetInformationJobObject',
      'int',
      ['void *', 'int', koffi.pointer(EXTENDED_LIMIT_INFORMATION), 'uint32_t'],
    ),
    CreateProcessW: kernel32.func('int __stdcall CreateProcessW(const char16_t *applicationName, void *commandLine, void *processAttributes, void *threadAttributes, int inheritHandles, uint32_t creationFlags, void *environment, const char16_t *currentDirectory, const SIMULATOR_STARTUPINFOW *startupInfo, _Out_ SIMULATOR_PROCESS_INFORMATION *processInformation)'),
    AssignProcessToJobObject: kernel32.func('int __stdcall AssignProcessToJobObject(void *job, void *process)'),
    ResumeThread: kernel32.func('uint32_t __stdcall ResumeThread(void *thread)'),
    TerminateJobObject: kernel32.func('int __stdcall TerminateJobObject(void *job, uint32_t exitCode)'),
    TerminateProcess: kernel32.func('int __stdcall TerminateProcess(void *process, uint32_t exitCode)'),
    QueryInformationJobObject: kernel32.func(
      '__stdcall',
      'QueryInformationJobObject',
      'int',
      ['void *', 'int', koffi.out(koffi.pointer(BASIC_ACCOUNTING_INFORMATION)), 'uint32_t', 'void *'],
    ),
    WaitForSingleObject: kernel32.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)'),
    GetExitCodeProcess: kernel32.func('int __stdcall GetExitCodeProcess(void *process, _Out_ uint32_t *exitCode)'),
    CloseHandle: kernel32.func('int __stdcall CloseHandle(void *handle)'),
    GetLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
  }
  return cachedWin32Api
}

function win32Error(api: Win32Api, operation: string): Error {
  return new Error(`${operation} failed with Win32 error ${api.GetLastError()}`)
}

class KoffiWindowsJobProcess implements ModuleProcess {
  readonly pid: number
  readonly exited: Promise<ProcessExit>
  private stopPromise?: Promise<void>
  private closed = false

  constructor(
    private readonly api: Win32Api,
    private readonly job: unknown,
    private readonly processHandle: unknown,
    pid: number,
    private readonly onClose: (process: KoffiWindowsJobProcess) => void,
  ) {
    this.pid = pid
    this.exited = this.pollForExit()
  }

  stopTree(graceMs: number): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    const attempt = this.stopTreeOnce(graceMs)
    this.stopPromise = attempt
    void attempt.catch(() => {
      if (this.stopPromise === attempt) this.stopPromise = undefined
    })
    return attempt
  }

  private async stopTreeOnce(graceMs: number): Promise<void> {
    if (!this.api.TerminateJobObject(this.job, 1)) throw win32Error(this.api, 'TerminateJobObject')
    const deadline = Date.now() + graceMs
    while (this.activeProcesses() > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    if (this.activeProcesses() > 0) throw new Error('Windows Job Object did not drain before cleanup timeout')
    await this.exited
    this.closeHandles()
  }

  private activeProcesses(): number {
    const accounting: { ActiveProcesses?: number } = {}
    if (!this.api.QueryInformationJobObject(
      this.job,
      JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS,
      accounting,
      koffi.sizeof(this.api.BASIC_ACCOUNTING_INFORMATION),
      null,
    )) {
      throw win32Error(this.api, 'QueryInformationJobObject')
    }
    return accounting.ActiveProcesses ?? 0
  }

  private async pollForExit(): Promise<ProcessExit> {
    while (this.api.WaitForSingleObject(this.processHandle, 0) === WAIT_TIMEOUT) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const waitResult = this.api.WaitForSingleObject(this.processHandle, 0)
    if (waitResult !== WAIT_OBJECT_0) throw win32Error(this.api, 'WaitForSingleObject')
    const exitCode: Array<number | null> = [null]
    if (!this.api.GetExitCodeProcess(this.processHandle, exitCode)) throw win32Error(this.api, 'GetExitCodeProcess')
    return { exitCode: exitCode[0] ?? null, signal: null }
  }

  private closeHandles(): void {
    if (this.closed) return
    this.closed = true
    this.api.CloseHandle(this.processHandle)
    this.api.CloseHandle(this.job)
    this.onClose(this)
  }
}

export class KoffiWindowsJobProcessFactory implements WindowsJobProcessFactory {
  private readonly api = createWin32Api()
  private readonly processes = new Set<KoffiWindowsJobProcess>()
  private disposed = false
  private disposing = false

  async spawn(request: ModuleSpawnRequest): Promise<ModuleProcess> {
    if (this.disposed || this.disposing) throw new Error('Windows Job Object process factory is disposing or disposed')
    const job = this.api.CreateJobObjectW(null, null)
    if (!job) throw win32Error(this.api, 'CreateJobObjectW')

    let processInfo: ProcessInformation | undefined
    try {
      const limits = {
        BasicLimitInformation: { LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE },
      }
      if (!this.api.SetInformationJobObject(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
        limits,
        koffi.sizeof(this.api.EXTENDED_LIMIT_INFORMATION),
      )) {
        throw win32Error(this.api, 'SetInformationJobObject')
      }

      processInfo = {}
      const startupInfo = { cb: koffi.sizeof(this.api.STARTUPINFO) }
      const commandLine = Buffer.from(`"${request.executable}"\0`, 'utf16le')
      const environment = createWindowsEnvironmentBlock(request.env)
      const created = this.api.CreateProcessW(
        request.executable,
        commandLine,
        null,
        null,
        0,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
        environment,
        request.cwd,
        startupInfo,
        processInfo,
      )
      if (!created || !processInfo.hProcess || !processInfo.hThread || !processInfo.dwProcessId) {
        throw win32Error(this.api, 'CreateProcessW')
      }
      if (!this.api.AssignProcessToJobObject(job, processInfo.hProcess)) {
        throw win32Error(this.api, 'AssignProcessToJobObject')
      }
      if (this.api.ResumeThread(processInfo.hThread) === RESUME_THREAD_FAILED) {
        throw win32Error(this.api, 'ResumeThread')
      }
      this.api.CloseHandle(processInfo.hThread)
      const moduleProcess = new KoffiWindowsJobProcess(
        this.api,
        job,
        processInfo.hProcess,
        processInfo.dwProcessId,
        (closed) => this.processes.delete(closed),
      )
      this.processes.add(moduleProcess)
      return moduleProcess
    } catch (error) {
      if (processInfo?.hProcess) this.api.TerminateProcess(processInfo.hProcess, 1)
      if (processInfo?.hThread) this.api.CloseHandle(processInfo.hThread)
      if (processInfo?.hProcess) this.api.CloseHandle(processInfo.hProcess)
      this.api.CloseHandle(job)
      throw error
    }
  }

  async dispose(graceMs = 2_000): Promise<void> {
    if (this.disposed) return
    if (this.disposing) throw new Error('Windows Job Object process factory disposal is already in progress')
    this.disposing = true
    try {
      await Promise.all([...this.processes].map((moduleProcess) => moduleProcess.stopTree(graceMs)))
      if (this.processes.size !== 0) throw new Error('Windows Job Object handles remain active during factory disposal')
      this.api.library.unload()
      if (cachedWin32Api === this.api) cachedWin32Api = undefined
      this.disposed = true
    } finally {
      this.disposing = false
    }
  }
}
