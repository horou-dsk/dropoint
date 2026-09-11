use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::Duration,
};

struct Server {
    child: Child,
    port: u16,
}

impl Server {
    fn start(directory: &Path, args: &[&str]) -> Self {
        let child = Command::new(env!("CARGO_BIN_EXE_dropoint"))
            .current_dir(directory)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut server = Self { child, port: 0 };
        let output = server.child.stdout.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if let Some(address) = line.strip_prefix("API server listening on http://") {
                    let port = address.rsplit(':').next().unwrap().parse::<u16>().unwrap();
                    let _ = sender.send(port);
                    break;
                }
            }
        });
        server.port = receiver
            .recv_timeout(Duration::from_secs(15))
            .expect("server should report its bound port");
        assert_ne!(server.port, 0);
        server
    }

    fn get(&self, path: &str) -> String {
        let mut socket = TcpStream::connect_timeout(
            &(Ipv4Addr::LOCALHOST, self.port).into(),
            Duration::from_secs(5),
        )
        .unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(
            socket,
            "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).unwrap();
        response
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn default_and_zero_ports_allocate_distinct_listeners_and_serve_the_current_directory() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("current.txt"), "current directory").unwrap();
    let first = Server::start(directory.path(), &[]);
    let second = Server::start(directory.path(), &["--port", "0"]);
    assert_ne!(first.port, second.port);
    for server in [&first, &second] {
        assert!(server.get("/api/health").contains(r#"{"status":"ok"}"#));
        assert!(server.get("/api/files").contains("current.txt"));
    }
}

#[test]
fn accepts_directory_and_explicit_port_in_either_order() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join("共享 files")).unwrap();
    std::fs::write(directory.path().join("共享 files/inside.txt"), "inside").unwrap();
    for directory_first in [true, false] {
        let reservation = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
        let port = reservation.local_addr().unwrap().port();
        let port_string = port.to_string();
        drop(reservation);
        let args = if directory_first {
            ["共享 files", "--port", &port_string]
        } else {
            ["-p", &port_string, "共享 files"]
        };
        let server = Server::start(directory.path(), &args);
        assert_eq!(server.port, port);
        assert!(server.get("/api/files").contains("inside.txt"));
    }
}

#[test]
fn rejects_invalid_arguments_and_explains_port_usage() {
    for args in [
        vec!["--port"],
        vec!["--port", "abc"],
        vec!["--port", "65536"],
        vec!["--port=-1"],
        vec!["--unknown"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_dropoint"))
            .args(&args)
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "invalid arguments accepted: {args:?}"
        );
        assert!(String::from_utf8_lossy(&output.stderr).contains("error:"));
    }
    let output = Command::new(env!("CARGO_BIN_EXE_dropoint"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).unwrap();
    assert!(help.contains("--port"));
    assert!(help.contains("unused port"));
}

#[test]
fn occupied_explicit_port_reports_failure_without_falling_back() {
    let occupied = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
    let port = occupied.local_addr().unwrap().port().to_string();
    let directory = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_dropoint"))
        .current_dir(directory.path())
        .args(["--port", &port])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains(&format!("failed to bind API port {port}"))
    );
}
