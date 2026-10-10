use std::{
    future::{Future, IntoFuture},
    io,
    time::Duration,
};

use axum::Router;
use tokio::{net::TcpListener, sync::oneshot};

const GRACE_PERIOD: Duration = Duration::from_secs(10);

pub struct Signals {
    #[cfg(unix)]
    interrupt: tokio::signal::unix::Signal,
    #[cfg(unix)]
    terminate: tokio::signal::unix::Signal,
    #[cfg(windows)]
    interrupt: tokio::signal::windows::CtrlC,
}

impl Signals {
    pub fn new() -> io::Result<Self> {
        // Keep the same listeners alive across both shutdown stages so a second
        // signal is not lost while the graceful-shutdown future completes.
        Ok(Self {
            #[cfg(unix)]
            interrupt: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?,
            #[cfg(unix)]
            terminate: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?,
            #[cfg(windows)]
            interrupt: tokio::signal::windows::ctrl_c()?,
        })
    }

    async fn recv(&mut self) {
        #[cfg(unix)]
        tokio::select! {
            _ = self.interrupt.recv() => {},
            _ = self.terminate.recv() => {},
        }
        #[cfg(windows)]
        self.interrupt.recv().await;
    }
}

pub async fn serve(listener: TcpListener, app: Router, mut signals: Signals) -> io::Result<()> {
    let (start, shutdown) = oneshot::channel();
    let server = axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = shutdown.await;
        })
        .into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => return result,
        _ = signals.recv() => {},
    }
    let _ = start.send(());
    eprintln!(
        "Shutting down: waiting up to {} seconds for active requests. Press Ctrl+C again to cancel them.",
        GRACE_PERIOD.as_secs()
    );
    match wait_for_requests(server, signals.recv()).await? {
        Completion::Graceful => {}
        Completion::Interrupted => {
            eprintln!("Second shutdown signal received; cancelling active requests.")
        }
        Completion::TimedOut => {
            eprintln!("Shutdown grace period expired; cancelling active requests.")
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
enum Completion {
    Graceful,
    Interrupted,
    TimedOut,
}

async fn wait_for_requests(
    server: impl Future<Output = io::Result<()>>,
    next_signal: impl Future<Output = ()>,
) -> io::Result<Completion> {
    tokio::select! {
        biased;
        result = server => result.map(|()| Completion::Graceful),
        _ = next_signal => Ok(Completion::Interrupted),
        _ = tokio::time::sleep(GRACE_PERIOD) => Ok(Completion::TimedOut),
    }
}

#[cfg(test)]
mod tests {
    use std::future::pending;

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn lets_active_requests_finish_before_the_deadline() {
        let (finished, request) = oneshot::channel();
        let waiting = tokio::spawn(wait_for_requests(
            async { request.await.unwrap() },
            pending(),
        ));
        tokio::task::yield_now().await;
        tokio::time::advance(GRACE_PERIOD - Duration::from_secs(1)).await;
        assert!(!waiting.is_finished());
        finished.send(Ok(())).unwrap();
        assert_eq!(waiting.await.unwrap().unwrap(), Completion::Graceful);
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_requests_are_cancelled_at_the_deadline() {
        let temporary = tempfile::NamedTempFile::new().unwrap();
        let path = temporary.path().to_owned();
        let waiting = tokio::spawn(wait_for_requests(
            async move {
                let _temporary = temporary;
                pending().await
            },
            pending(),
        ));
        tokio::task::yield_now().await;
        tokio::time::advance(GRACE_PERIOD).await;
        assert_eq!(waiting.await.unwrap().unwrap(), Completion::TimedOut);
        assert!(!path.exists());
    }

    #[tokio::test(start_paused = true)]
    async fn a_second_signal_cancels_requests_without_waiting_for_the_deadline() {
        let temporary = tempfile::NamedTempFile::new().unwrap();
        let path = temporary.path().to_owned();
        let (interrupt, signal) = oneshot::channel();
        let started = tokio::time::Instant::now();
        let waiting = tokio::spawn(wait_for_requests(
            async move {
                let _temporary = temporary;
                pending().await
            },
            async { signal.await.unwrap() },
        ));
        tokio::task::yield_now().await;
        interrupt.send(()).unwrap();
        assert_eq!(waiting.await.unwrap().unwrap(), Completion::Interrupted);
        assert!(started.elapsed() < GRACE_PERIOD);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn preserves_server_errors() {
        let error = wait_for_requests(async { Err(io::Error::other("server failure")) }, pending())
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "server failure");
    }
}
