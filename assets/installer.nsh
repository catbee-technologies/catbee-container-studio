!macro customInit
  !ifndef ONE_CLICK
    !ifndef INSTALL_MODE_PER_ALL_USERS
      # initMultiUser has already restored the registered install scope and directory.
      # Keep the scope picker when both scopes exist or neither is registered.
      ${If} ${isUpdated}
      ${AndIf} $hasPerUserInstallation != $hasPerMachineInstallation
        SetSilent silent
      ${EndIf}
    !endif
  !endif
!macroend
