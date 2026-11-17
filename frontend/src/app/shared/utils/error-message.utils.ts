export function formatErrorMessage(error: string): { message: string; details: string | null } {
  const primaryError = error.split(/\bRollback failures:/i)[0];
  const port = primaryError.match(/\b(?:bind for|listen (?:tcp|udp|sctp)[46]?)\s+\S+:(\d+)\b/i)?.[1];
  const protocol = primaryError.match(/:\d+\/(tcp|udp|sctp)\b/i)?.[1];
  const containerName = primaryError.match(/\bcontainer name\s+["']\/?([^"']+)["']\s+is already in use\b/i)?.[1];
  const missingResource = primaryError.match(/\bno such (container|image|volume|network)\s*:/i)?.[1]?.toLowerCase();
  let message: string;

  if (
    /\bport is already allocated\b/i.test(primaryError) ||
    (port && /\baddress already in use\b/i.test(primaryError))
  ) {
    message = port
      ? `Host port ${port} is already in use. Choose another port.`
      : 'A host port is already in use. Choose another port.';
  } else if (/\bprotocol not supported\b/i.test(primaryError)) {
    message = protocol
      ? `This Docker host does not support ${protocol.toUpperCase()} port publishing. Use a supported protocol.`
      : 'The requested networking protocol is not supported by this host.';
  } else if (/\bduplicate mount point\b/i.test(primaryError)) {
    message = 'Multiple mounts use the same container path. Use a unique destination for each mount.';
  } else if (containerName) {
    message = `Container name "${containerName}" is already in use. Choose another name.`;
  } else if (missingResource === 'image' || /\bmanifest unknown\b/i.test(primaryError)) {
    message = 'The container image is unavailable. Check the image name and tag, then pull it and try again.';
  } else if (missingResource) {
    message = `The ${missingResource} no longer exists. Refresh and try again.`;
  } else if (
    /\bpull access denied\b|\bunauthorized: authentication required\b|\bno basic auth credentials\b/i.test(primaryError)
  ) {
    message = 'Cannot access this image. Check the image name and registry sign-in.';
  } else if (/\bvolume is in use\b/i.test(primaryError)) {
    message =
      'This volume is used by a container. Remove the container or its volume attachment before deleting the volume.';
  } else if (/\bhas active endpoints\b/i.test(primaryError)) {
    message = 'This network still has connected containers. Disconnect them before deleting the network.';
  } else if (/\bimage is being used by\b.*\bcontainer\b/i.test(primaryError)) {
    message = 'This image is used by a container. Remove the container before deleting the image.';
  } else if (/\bbind source path does not exist\b/i.test(primaryError)) {
    message = 'The host mount path does not exist. Choose an existing file or folder.';
  } else if (/\bcannot connect to the docker daemon\b|\bis the docker daemon running\b/i.test(primaryError)) {
    message = 'Cannot connect to Docker Engine. Make sure Docker is running and try again.';
  } else if (/\bEACCES\b|\bEPERM\b|\bpermission denied\b/i.test(primaryError)) {
    message = 'Permission denied. Check access permissions for the requested resource.';
  } else if (/\bENOSPC\b|\bno space left on device\b/i.test(primaryError)) {
    message = 'There is not enough disk space. Free up space and try again.';
  } else if (/\bread-only file system\b/i.test(primaryError)) {
    message = 'The filesystem is read-only. Use a writable location or change the mount permissions.';
  } else if (/\bECONNREFUSED\b/i.test(primaryError)) {
    message = 'The connection was refused. Check that the service is running and the address is correct.';
  } else if (/\bETIMEDOUT\b|\bconnection timed out\b/i.test(primaryError)) {
    message = 'The connection timed out. Check your network connection and try again.';
  } else if (/\bENOTFOUND\b|\bEAI_AGAIN\b/i.test(primaryError)) {
    message = 'The server address could not be resolved. Check the address and your network connection.';
  } else {
    return { message: error, details: null };
  }

  if (/\bRollback failures:/i.test(error)) {
    message += ' Automatic recovery also failed. See Details before retrying.';
  }

  return { message, details: error };
}
